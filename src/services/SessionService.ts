/**
 * Change-session lifecycle: one {@link ChangeSession} per agent turn.
 *
 * Drives sessions from the session event log — `turn/start` opens a new
 * session (bound to the agent session and its cwd), `turn/end` completes it,
 * and `agent/error` marks the active one failed. Captured changes attach to
 * the currently active session for their agent; statistics (files, inserted
 * and deleted lines) accumulate from each change's diff.
 *
 * Listens from the root context: untagged listeners receive every
 * session-scoped event (the same pattern as session-persistence), so one
 * coordinator covers all agents.
 * @module dsh-change-center/services
 */

import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.fs` Context merge into scope.
import type {} from '@deepseek-ai/dsh-fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ChangeSession, ChangeSessionStatus, ChangeStatistics } from '../models/ChangeSession.ts'
import type { ChangeOperation } from '../models/FileChange.ts'
import { summarizeChanges } from '../models/sessionSummary.ts'
import type { ChangeService } from './ChangeService.ts'
import { countDiff } from './DiffService.ts'
import { JsonlStore, maxIdSuffix } from './JsonlStore.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    changeSessions: SessionService
  }
}

/** The active session keyed by agent session id (as a string). */
type AgentSessionKey = string

/**
 * Groups change ids under one session and owns the session lifecycle. One
 * session maps to one agent turn; a session with no changes still opens and
 * closes with its turn.
 */
export class SessionService extends Service {
  static inject = ['changeCenter']

  private readonly sessions = new Map<string, ChangeSession>()
  /** agentSessionKey → currently active session id. */
  private readonly active = new Map<AgentSessionKey, string>()
  /** agentSessionKey → relative path → operation (S-8 摘要推导 + files 统计). */
  private readonly paths = new Map<AgentSessionKey, Map<string, ChangeOperation>>()
  private nextId = 1
  /** Durable JSONL store (no-op when the `fs` service is absent). */
  private readonly store: JsonlStore<ChangeSession>
  private loadPromise: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'changeSessions')
    this.store = new JsonlStore(
      () => this.ctx.get('fs'),
      join(resolveDshHome(), 'change-center', 'store', 'sessions.jsonl'),
    )
    // Start the disk load immediately so the id counter is restored before
    // the first session opens (shrinks the load/mutation race window).
    void this.ensureLoaded()

    ctx.on('session/event', (session: Session, event: { type: string; turn?: number; reason?: string; data?: unknown }) => {
      if (event.type === 'turn/start') {
        this.open(session)
      } else if (event.type === 'turn/end') {
        this.complete(session, event.reason)
      } else if (event.type === 'session/title') {
        // 标题(自动生成或用户重命名)到达 → 更新会话名,标题优先于轮次。
        const title = (event.data as { title?: unknown } | undefined)?.title
        if (typeof title === 'string' && title.length > 0) {
          const id = this.active.get(String(session.id))
          const cs = id !== undefined ? this.sessions.get(id) : undefined
          if (cs !== undefined) {
            cs.title = title
            cs.name = title
            this.persist()
          }
        }
      }
    })

    ctx.on('agent/error', ({ agent }) => {
      const key = String(agent.session.id)
      const id = this.active.get(key)
      if (id !== undefined) this.setStatus(id, 'failed')
    })

    ctx.on('change.created', (change) => {
      const key = change.sessionId
      // Every captured change belongs to a session: attach to the active one,
      // opening a fallback group if no turn/start was observed (headless or
      // non-loop callers).
      let id = this.active.get(key)
      if (id === undefined) {
        const session = this.openFallback(key, change.cwd)
        id = session.id
      }
      const session = this.sessions.get(id)
      if (session === undefined) return
      session.changeIds.push(change.id)
      // Statistics count FILE changes only: command/external records have no
      // content diff (their `after` is the command text), so counting them
      // would inflate the +N/-N header and the file count beyond what the
      // review surface shows.
      if (change.kind === 'file') {
        const counts = countDiff(change.before, change.after)
        session.statistics.additions += counts.additions
        session.statistics.deletions += counts.deletions
        let paths = this.paths.get(key)
        if (paths === undefined) {
          paths = new Map()
          this.paths.set(key, paths)
        }
        // S-8:记录相对路径 + 操作,用于自然语言摘要(随会话落库)。
        paths.set(relPathOf(change), change.operation)
        session.statistics.files = paths.size
        session.summary = deriveSummary(paths)
        // 会话名 = 「第 N 轮 / 会话 xxx」 + 变更摘要;已有 agent 会话标题时保持标题。
        if (session.title === undefined) {
          const prefix = session.name.split(' · ')[0] ?? session.name
          session.name = `${prefix} · ${session.summary}`
        }
      }
      session.updatedAt = Date.now()
      this.persist()
    })
  }

  /** Load persisted sessions once; safe to call repeatedly. */
  private ensureLoaded(): Promise<void> {
    if (this.loadPromise === undefined) {
      this.loadPromise = this.loadFromDisk().catch(() => undefined)
    }
    return this.loadPromise
  }

  /** Fill the in-memory map from disk and restore the id counter. */
  private async loadFromDisk(): Promise<void> {
    const records = await this.store.load()
    for (const session of records) {
      // Sessions created in this process win over stale disk copies.
      if (typeof session?.id === 'string' && !this.sessions.has(session.id)) {
        // A session persisted as `active` was mid-turn when the process died:
        // there is no live turn to resume, so reconcile it as completed.
        if (session.status === 'active') {
          session.status = 'completed'
        }
        this.sessions.set(session.id, session)
      }
    }
    const ids = records.map(r => r?.id).filter((id): id is string => typeof id === 'string')
    this.nextId = Math.max(this.nextId, maxIdSuffix(ids, 'session') + 1)
  }

  /** Fire-and-forget persist of the whole store (serialized, best-effort). */
  private persist(): void {
    void this.ensureLoaded().then(() => this.store.save([...this.sessions.values()]))
  }

  /** All sessions, most recently updated first. */
  list(): ChangeSession[] {
    void this.ensureLoaded()
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): ChangeSession | undefined {
    void this.ensureLoaded()
    return this.sessions.get(id)
  }

  /** The {@link ChangeService} records aggregated under a session. */
  changesOf(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return []
    const changes = this.ctx.get('changeCenter')
    if (changes === undefined) return []
    return session.changeIds
      .map(id => changes.get(id))
      .filter((change): change is NonNullable<typeof change> => change !== undefined)
  }

  /** Set a session's status and emit `session.updated` / `session.completed`. */
  setStatus(id: string, status: ChangeSessionStatus): ChangeSession | undefined {
    const session = this.sessions.get(id)
    if (session === undefined) return undefined
    if (session.status === status) return session
    session.status = status
    session.updatedAt = Date.now()
    // 终态(completed/failed/cancelled)发 `session.completed`,其余发 `session.updated`。
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.ctx.emit('session.completed', session)
      // S-5:turn 结束后只保留最近 N 个快照,保证「刚应用完可 Undo」同时磁盘有界。
      void this.ctx.get('snapshots')?.pruneSession(session.agentSessionId, 5)
    } else {
      this.ctx.emit('session.updated', session)
    }
    this.persist()
    return session
  }

  /** Open a new session for the agent's turn. */
  private open(session: Session): ChangeSession {
    const key = String(session.id)
    const id = `session-${this.nextId++}`
    const created: ChangeSession = {
      id,
      // 命名便于管理:有 agent 会话标题则用之(用户重命名/自动标题);否则第 N 轮,变更到达后追加摘要。
      name: this.titleOf(session) ?? `第 ${this.turnOf(session)} 轮`,
      status: 'active',
      agentSessionId: key,
      workspace: session.header.cwd ?? '',
      changeIds: [],
      statistics: { files: 0, additions: 0, deletions: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.sessions.set(id, created)
    this.active.set(key, id)
    this.ctx.emit('session.created', created)
    this.persist()
    return created
  }

  /** Complete the agent's active session on turn end. */
  private complete(session: Session, reason: string | undefined): void {
    const key = String(session.id)
    const id = this.active.get(key)
    if (id === undefined) return
    this.active.delete(key)
    // A turn ending in error was already failed via agent/error; the closing
    // reason here only matters for an errored turn without that event.
    const status: ChangeSessionStatus = reason === 'error' ? 'failed' : 'completed'
    this.setStatus(id, status)
  }

  /** Fallback group for captures without a preceding turn/start. */
  private openFallback(agentSessionId: string, workspace: string): ChangeSession {
    const id = `session-${this.nextId++}`
    const created: ChangeSession = {
      id,
      name: `会话 ${shortId(agentSessionId)}`,
      status: 'active',
      agentSessionId,
      workspace,
      changeIds: [],
      statistics: { files: 0, additions: 0, deletions: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.sessions.set(id, created)
    this.active.set(agentSessionId, id)
    this.ctx.emit('session.created', created)
    this.persist()
    return created
  }

  /** 读取 agent 会话当前标题(经 sessionProjections;headless 无 projection 时返回 undefined)。 */
  private titleOf(session: Session): string | undefined {
    const projections = this.ctx.get('sessionProjections')
    if (projections === undefined) return undefined
    try {
      const snap = projections.snapshot(session)
      const title = (snap.values as { title?: string | null }).title
      return typeof title === 'string' && title.length > 0 ? title : undefined
    } catch {
      return undefined
    }
  }

  /** The latest turn number recorded on the session log, or 1. */
  private turnOf(session: Session): number {
    let turn = 1
    for (const event of session.events) {
      const data = event.data as { turn?: number }
      if (typeof data.turn === 'number' && data.turn >= turn) turn = data.turn
    }
    return turn
  }
}

/** Current wall-clock time as HH:MM (for unambiguous session names). */
function hhmm(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** Last 6 chars of an agent session id (for compact fallback names). */
function shortId(id: string): string {
  return id.length > 6 ? id.slice(-6) : id
}

/** 变更路径相对工作区的形式(摘要用;绝对路径保留原样)。 */
function relPathOf(change: { path: string; cwd: string }): string {
  const base = (change.cwd ?? '').replace(/\/+$/, '')
  if (base.length > 0 && change.path.startsWith(`${base}/`)) {
    return change.path.slice(base.length + 1)
  }
  return change.path
}

/**
 * 会话自然语言摘要(3.x):host 与客户端共用 `models/sessionSummary.ts` 的
 * `summarizeChanges`,保证落库摘要与客户端兜底文案一致。
 */
function deriveSummary(opsByRelPath: Map<string, ChangeOperation>): string {
  return summarizeChanges(
    [...opsByRelPath.entries()].map(([path, operation]) => ({ path, cwd: '', operation, kind: 'file' })),
  )
}

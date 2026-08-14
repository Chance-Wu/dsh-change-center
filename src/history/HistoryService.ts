/**
 * Change history: records every lifecycle step of a change session as a
 * {@link ChangeEvent} and persists it under
 * `$DSH_HOME/change-center/history/<sessionId>.json`.
 *
 * The service listens to the plugin's own Cordis events (change:created,
 * change:approved, …) and translates them into durable history entries. The
 * event stream is also exposed as a per-session timeline. Persistence goes
 * through the `ctx.fs` seam (atomic writes, sandbox/approval aware).
 * @module dsh-change-center/history
 */

import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context, Events } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.fs` Context merge into scope.
import type {} from '@deepseek-ai/dsh-fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ChangeEvent, ChangeEventActor, ChangeEventType } from '../models/Phase3.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    changeHistory: HistoryService
  }
}

/** A subscriber entry translating one plugin event into a ChangeEvent. */
interface EventMapping {
  event: string
  type: ChangeEventType
  actor: ChangeEventActor
  /** Extract the sessionId from the event payload. */
  sessionOf: (args: unknown[]) => string | undefined
  /** Extract an optional changeId from the event payload. */
  changeOf?: (args: unknown[]) => string | undefined
  /** Extract optional metadata from the event payload. */
  metaOf?: (args: unknown[]) => Record<string, unknown> | undefined
}

/** Records and persists change-session lifecycle events. */
export class HistoryService extends Service {
  static inject = ['fs']

  private readonly root: string
  private readonly events = new Map<string, ChangeEvent[]>()
  private nextId = 1

  constructor(ctx: Context) {
    super(ctx, 'changeHistory')
    this.root = join(resolveDshHome(), 'change-center', 'history')

    const idOf = (args: unknown[]): string | undefined => {
      const first = args[0] as { id?: string } | undefined
      return typeof first?.id === 'string' ? first.id : undefined
    }
    const sessionIdOf = (args: unknown[]): string | undefined => {
      const first = args[0] as { sessionId?: string } | undefined
      return typeof first?.sessionId === 'string' ? first.sessionId : undefined
    }
    // ChangeSession carries `id` + `agentSessionId` (no `sessionId` field);
    // history is keyed by the AGENT session id, matching change events.
    const changeSessionKeyOf = (args: unknown[]): string | undefined => {
      const first = args[0] as { agentSessionId?: string; id?: string } | undefined
      if (typeof first?.agentSessionId === 'string') return first.agentSessionId
      return typeof first?.id === 'string' ? first.id : undefined
    }

    const mappings: EventMapping[] = [
      { event: 'change:created', type: 'created', actor: 'agent', sessionOf: sessionIdOf, changeOf: idOf },
      { event: 'change:approved', type: 'approved', actor: 'user', sessionOf: sessionIdOf, changeOf: idOf },
      { event: 'change:rejected', type: 'rejected', actor: 'user', sessionOf: sessionIdOf, changeOf: idOf },
      { event: 'change:applied', type: 'applied', actor: 'user', sessionOf: sessionIdOf, changeOf: idOf },
      { event: 'change:rollback', type: 'rolled_back', actor: 'user', sessionOf: sessionIdOf, changeOf: idOf },
      { event: 'change-session:created', type: 'created', actor: 'agent', sessionOf: changeSessionKeyOf },
    ]

    for (const mapping of mappings) {
      // The mapping names are a subset of the plugin's declared Events; the
      // cast bridges the generic key to the specific event names.
      ctx.on(mapping.event as keyof Events, (...args: unknown[]) => {
        const sessionId = mapping.sessionOf(args)
        if (sessionId === undefined) return
        void this.record({
          sessionId,
          ...mapping.changeOf !== undefined ? { changeId: mapping.changeOf(args) } : {},
          type: mapping.type,
          actor: mapping.actor,
          ...mapping.metaOf !== undefined ? { metadata: mapping.metaOf(args) } : {},
        })
      })
    }
  }

  /** Record one change event in memory and persist it. */
  async record(input: Omit<ChangeEvent, 'id' | 'timestamp'>): Promise<ChangeEvent> {
    const event: ChangeEvent = {
      id: `event-${this.nextId++}`,
      ...input,
      timestamp: Date.now(),
    }
    const list = this.events.get(event.sessionId) ?? []
    list.push(event)
    this.events.set(event.sessionId, list)
    await this.persist(event.sessionId, list)
    this.ctx.emit('history:recorded', event)
    return event
  }

  /** All recorded events for a session, oldest first. */
  list(sessionId: string): ChangeEvent[] {
    return [...(this.events.get(sessionId) ?? [])].sort((a, b) => a.timestamp - b.timestamp)
  }

  /** The timeline for a session: events with a human-readable label. */
  timeline(sessionId: string): { events: ChangeEvent[] } {
    return { events: this.list(sessionId) }
  }

  private async persist(sessionId: string, events: ChangeEvent[]): Promise<void> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    try {
      const target = await fs.resolve(join(this.root, safe(sessionId), 'history.json'))
      await fs.writeText(target, JSON.stringify(events, null, 2))
    } catch {
      // Best-effort persistence: history still lives in memory.
    }
  }

  /** Load persisted history for a session into memory (cold start). */
  async load(sessionId: string): Promise<void> {
    if (this.events.has(sessionId)) return
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    try {
      const target = await fs.resolve(join(this.root, safe(sessionId), 'history.json'))
      if (await fs.stat(target) === undefined) return
      const parsed = JSON.parse(await fs.readText(target)) as ChangeEvent[]
      if (Array.isArray(parsed)) {
        this.events.set(sessionId, parsed)
        for (const event of parsed) {
          const seq = Number(/event-(\d+)/.exec(event.id)?.[1] ?? 0)
          if (seq >= this.nextId) this.nextId = seq + 1
        }
      }
    } catch {
      // No persisted history yet.
    }
  }
}

/** Neutralize path separators so session ids cannot traverse out. */
function safe(segment: string): string {
  return segment.replace(/[/\\]/g, '_')
}

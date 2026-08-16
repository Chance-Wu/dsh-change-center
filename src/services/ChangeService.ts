/**
 * In-memory store and review state machine for captured file changes.
 *
 * The store owns every {@link FileChange}, assigns ids, derives diffs, and
 * enforces review transitions. Apply (real write-back) and rollback (snapshot
 * restore) are delegated to the {@link ApplyService} and
 * {@link SnapshotService} engines; the store coordinates the sequence and
 * the state transitions around them.
 * @module dsh-change-center/services
 */

import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.fs` Context merge into scope.
import type {} from '@deepseek-ai/dsh-fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { FileChange, ChangeOperation, ChangeStatus, ChangeSource, ChangeKind } from '../models/FileChange.ts'
import { CHANGE_TRANSITIONS as TRANSITIONS } from '../models/ChangeState.ts'
import { applyHunks, diffHunks, renderUnified } from './DiffService.ts'
import type { DiffHunk } from './DiffService.ts'
import { JsonlStore, maxIdSuffix } from './JsonlStore.ts'
import type { ApplyService, ApplyResult } from './ApplyService.ts'
import { sha256 } from './ApplyService.ts'
import type { SnapshotService, RollbackResult } from './SnapshotService.ts'
import { workspaceWritePolicy } from './pluginFs.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    changeCenter: ChangeService
  }
}

/** Inputs for recording one captured change. */
export interface NewFileChange {
  sessionId: string
  /** Session working directory the path was resolved against. */
  cwd: string
  /** Unified change kind; defaults to 'file'. */
  kind?: ChangeKind
  path: string
  operation: ChangeOperation
  before: string | null
  after: string | null
  source: ChangeSource
  toolName: string
  toolCallId?: string
}

/** One state-machine action result that failed (no throw / no 500). */
export interface ActionError {
  kind: 'error'
  message: string
}

/**
 * Result of {@link ChangeService.rollbackAll}. The counters are disjoint:
 * `rolledBack + missing + failed` = every applied change in the session.
 */
export interface RollbackAllResult {
  /** Changes successfully restored to their pre-apply state. */
  rolledBack: string[]
  /** Applied changes whose snapshot is gone (no restore possible). */
  missing: string[]
  /** Changes whose rollback failed, with a reason. */
  failed: { id: string; message: string }[]
}

/** Normalize a thrown transition error into an {@link ActionError}. */
function actionError(error: unknown): ActionError {
  return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
}

/**
 * Result of {@link ChangeService.applyAllPending}.
 *
 * The counters partition the session's changes into disjoint categories:
 * `applied + failed + blocked` = pending changes actually processed, `skipped`
 * = other non-pending changes, `superseded` = older writes to a path whose
 * newer change was processed.
 */
export interface ApplyAllResult {
  /** Approved changes successfully applied (incl. command/external). */
  applied: string[]
  /** Changes skipped: not pending (already applied/rejected/approved). */
  skipped: string[]
  /** Older changes to a path superseded by a newer change (not applied). */
  superseded: string[]
  /** Changes that failed to apply, with a reason. */
  failed: { id: string; message: string }[]
  /**
   * Changes held back by a deny policy: left pending, not applied, until the
   * policy is adjusted or the change is handled individually.
   */
  blocked: { id: string; message: string }[]
  /**
   * 4.5 Safe Apply:通过 Prepare 预检、进入 Commit 阶段的待审变更数
   * (冲突/deny 在写盘前已从该数中排除)。
   */
  prepared: number
}

/** 4.7 Change Analytics:轻量统计(不是监控平台)。 */
export interface ChangeAnalytics {
  /** 时间窗内触及的文件数(去重)。 */
  files: number
  /** 成功应用数。 */
  applied: number
  /** 失败数。 */
  failed: number
  /** 成功率百分比(0-100)。 */
  successRate: number
  /** 回滚数。 */
  rollbacks: number
  /** 高频修改文件 Top N。 */
  topFiles: { path: string; count: number }[]
}

/** 状态机唯一事实源(3.x):见 `models/ChangeState.ts`(host/client 共用)。 */

/**
 * The change-center store: owns every {@link FileChange}, assigns ids,
 * derives diffs, and enforces review transitions. Apply (real write-back)
 * and rollback (snapshot restore) delegate to the optional
 * {@link ApplyService}/{@link SnapshotService} engines; absent them (pure
 * state-machine compositions), apply reports a clear error.
 */
export class ChangeService extends Service {
  private readonly changes = new Map<string, FileChange>()
  private nextId = 1
  /** Durable JSONL store (no-op when the `fs` service is absent). */
  private readonly store: JsonlStore<FileChange>
  private loadPromise: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'changeCenter')
    this.store = new JsonlStore(
      () => this.ctx.get('fs'),
      join(resolveDshHome(), 'change-center', 'store', 'changes.jsonl'),
    )
    // Start the disk load immediately so the id counter is restored before
    // the first capture lands (shrinks the load/mutation race window).
    void this.ensureLoaded()
  }

  /** Load persisted changes once; safe to call repeatedly. */
  private ensureLoaded(): Promise<void> {
    if (this.loadPromise === undefined) {
      this.loadPromise = this.loadFromDisk().catch(() => undefined)
    }
    return this.loadPromise
  }

  /** Fill the in-memory map from disk and restore the id counter. */
  private async loadFromDisk(): Promise<void> {
    const records = await this.store.load()
    for (const change of records) {
      // Records created in this process win over stale disk copies; the
      // remaining disk records are restored for restart continuity.
      if (typeof change?.id === 'string' && !this.changes.has(change.id)) {
        this.changes.set(change.id, change)
      }
    }
    const ids = records.map(r => r?.id).filter((id): id is string => typeof id === 'string')
    this.nextId = Math.max(this.nextId, maxIdSuffix(ids, 'change') + 1)
  }

  /** Fire-and-forget persist of the whole store (serialized, best-effort). */
  private persist(): void {
    void this.ensureLoaded().then(() => this.store.save([...this.changes.values()]))
  }

  /** Record a captured change and emit `change.created`. */
  record(input: NewFileChange): FileChange {
    void this.ensureLoaded()
    const change: FileChange = {
      id: `change-${this.nextId++}`,
      sessionId: input.sessionId,
      cwd: input.cwd,
      kind: input.kind ?? 'file',
      path: input.path,
      operation: input.operation,
      before: input.before,
      after: input.after,
      // 3.x:捕获发生在工具写盘之后,已知磁盘状态 = after(命令/外部记录无磁盘态)。
      diskBaseline: (input.kind ?? 'file') === 'file' ? input.after : undefined,
      diff: renderUnified(input.before, input.after),
      status: 'pending',
      source: input.source,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.changes.set(change.id, change)
    this.ctx.emit('change.created', change)
    this.persist()
    return change
  }

  /** All recorded changes, newest first. */
  list(): FileChange[] {
    void this.ensureLoaded()
    // 3.x Batch 契约:createdAt 相同时(同一毫秒内的两次写入)按记录序号
    // 决出「最新」,保证同路径去重时最新变更稳定胜出。
    const seqOf = (id: string): number => Number(id.split('-').pop() ?? 0)
    return [...this.changes.values()].sort((a, b) => b.createdAt - a.createdAt || seqOf(b.id) - seqOf(a.id))
  }

  /** Changes belonging to one session, newest first. */
  listBySession(sessionId: string): FileChange[] {
    return this.list().filter(change => change.sessionId === sessionId)
  }

  get(id: string): FileChange | undefined {
    void this.ensureLoaded()
    return this.changes.get(id)
  }

  /** Transition a change to the target status, emitting the matching event. */
  private transition(id: string, target: ChangeStatus): FileChange {
    const change = this.changes.get(id)
    if (change === undefined) {
      throw new Error(`change-center: unknown change "${id}"`)
    }
    const allowed = TRANSITIONS[change.status]
    if (!allowed.includes(target)) {
      throw new Error(`change-center: cannot transition "${change.id}" from ${change.status} to ${target}`)
    }
    change.status = target
    change.updatedAt = Date.now()
    this.persist()
    return change
  }

  /**
   * Apply a change to the workspace: snapshot the pre-apply file, run the
   * apply engine's content-hash guard and atomic write, then transition.
   * Command/external changes are marked applied without re-running them.
   * @param id - the change to apply.
   * @param force - bypass the external-mutation guard.
   * @returns the engine result; the change's status reflects the outcome.
   */
  async apply(id: string, force = false): Promise<ApplyResult> {
    const change = this.changes.get(id)
    if (change === undefined) {
      return { kind: 'error', message: `unknown change "${id}"` }
    }
    if (change.status === 'applied') {
      return { kind: 'error', message: `change "${id}" is already applied` }
    }
    // Command/external changes are recorded, not re-executed: approving one
    // marks it applied directly (the agent already ran the command live).
    if (change.kind !== 'file') {
      this.transition(id, 'applied')
      this.ctx.emit('change.updated', change)
      return { kind: 'applied', operation: 'execute' }
    }
    // 3.x Apply 语义统一:策略 deny 是真正的 Guard(与批量一致),force 显式绕过;
    // 变更保持 pending,由 UI 给出「仍然应用」路径。
    if (!force) {
      const policies: { evaluate: (changes: FileChange[]) => Promise<{ action: string; reason: string }[]> } | undefined = this.ctx.get('policies')
      if (policies !== undefined) {
        const evaluations = await policies.evaluate([change])
        const denial = evaluations.find(evaluation => evaluation.action === 'deny')
        if (denial !== undefined) {
          return { kind: 'error', message: `policy deny: ${denial.reason}` }
        }
      }
    }
    const applyEngine: ApplyService | undefined = this.ctx.get('applyEngine')
    const snapshots: SnapshotService | undefined = this.ctx.get('snapshots')
    if (applyEngine === undefined || snapshots === undefined) {
      const message = 'apply engine unavailable (ApplyService/SnapshotService not mounted)'
      this.transition(id, 'failed')
      this.ctx.emit('change.updated', change, message)
      return { kind: 'error', message }
    }
    try {
      // Qoder 块状态:文件变更存在逐块撤销/编辑时,「应用」写回重构后的内容
      // (全部块应用 + 保留块内编辑),而不是原始 after —— 否则会覆盖用户
      // 在 diff 里做的块级修改。写盘路径与 applyHunk/editHunk 完全一致。
      if (change.hunkApplied !== undefined || change.hunkEdits !== undefined) {
        const hunks = diffHunks(change.before, change.after)
        const appliedAll = hunks.map(() => true)
        const content = applyHunks(change.before, hunks, appliedAll, change.hunkEdits)
        return this.writeHunk(change, hunks, appliedAll, change.hunkEdits ?? [], content, force)
      }
      await snapshots.snapshot(change)
      const result = await applyEngine.apply(change, force)
      if (result.kind === 'applied') {
        // 3.x:应用成功后,已知磁盘状态 = 当前 after(删除 → 文件不存在)。
        change.diskBaseline = change.operation === 'delete' ? null : change.after
        this.transition(id, 'applied')
        this.ctx.emit('change.updated', change)
      } else if (result.kind === 'conflict') {
        this.transition(id, 'failed')
        this.ctx.emit('change.updated', change, 'external modification detected')
      } else {
        this.transition(id, 'failed')
        this.ctx.emit('change.updated', change, result.message)
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.transition(id, 'failed')
      this.ctx.emit('change.updated', change, message)
      return { kind: 'error', message }
    }
  }

  /**
   * Qoder 风格块级操作:应用或撤销 diff 中的单个 hunk,并把结果写回工作区。
   *
   * 捕获发生在工具写盘之后,文件初始 = after ⇒ 每个 hunk 默认已应用
   * (`hunkApplied` 缺省 = 全 true)。「撤销该块」把该区域恢复为 before 内容
   * (同时丢弃该块已有的编辑),「应用该块」重新写回 after 内容;其余块保持
   * 不变(逐块接受语义)。写入带 diskBaseline 外部修改守卫(与 apply 一致,
   * force 绕过)。
   *
   * @param id - change id。
   * @param index - hunk 序号(与 `diffHunks(before, after)` 顺序一致)。
   * @param revert - true=撤销该块,false=应用该块。
   * @param force - 绕过外部修改守卫。
   */
  async applyHunk(id: string, index: number, revert = false, force = false): Promise<ApplyResult> {
    const change = this.changes.get(id)
    if (change === undefined) {
      return { kind: 'error', message: `unknown change "${id}"` }
    }
    if (change.kind !== 'file' || change.before === null || change.after === null) {
      return { kind: 'error', message: 'hunk operations require a file change with before/after content' }
    }
    const hunks = diffHunks(change.before, change.after)
    if (index < 0 || index >= hunks.length) {
      return { kind: 'error', message: `hunk index ${index} out of range (${hunks.length} hunks)` }
    }
    const applied = change.hunkApplied ?? hunks.map(() => true)
    applied[index] = !revert
    // 撤销某块 = 丢弃该块的编辑(再应用时回到原始 after 内容)。
    const edits = change.hunkEdits !== undefined ? [...change.hunkEdits] : []
    if (revert) edits[index] = null
    const content = applyHunks(change.before, hunks, applied, edits)
    return this.writeHunk(change, hunks, applied, edits, content, force)
  }

  /**
   * Qoder 风格块内编辑:用用户修改后的行替换某个 hunk 的写入内容,并写回工作区。
   * 编辑即应用(该块 applied=true),其余块保持原有状态;编辑后磁盘基线更新为
   * 新内容,后续 apply/apply-all 不会用原始 after 覆盖掉用户的修改。
   *
   * @param id - change id。
   * @param index - hunk 序号。
   * @param lines - 该块修改后的完整写入行(不含行尾分隔符)。
   * @param force - 绕过外部修改守卫。
   */
  async editHunk(id: string, index: number, lines: string[], force = false): Promise<ApplyResult> {
    const change = this.changes.get(id)
    if (change === undefined) {
      return { kind: 'error', message: `unknown change "${id}"` }
    }
    if (change.kind !== 'file' || change.before === null || change.after === null) {
      return { kind: 'error', message: 'hunk operations require a file change with before/after content' }
    }
    if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string')) {
      return { kind: 'error', message: 'hunk edit requires an array of string lines' }
    }
    const hunks = diffHunks(change.before, change.after)
    if (index < 0 || index >= hunks.length) {
      return { kind: 'error', message: `hunk index ${index} out of range (${hunks.length} hunks)` }
    }
    const applied = change.hunkApplied ?? hunks.map(() => true)
    applied[index] = true
    const edits = change.hunkEdits !== undefined ? [...change.hunkEdits] : []
    edits[index] = lines
    const content = applyHunks(change.before, hunks, applied, edits)
    return this.writeHunk(change, hunks, applied, edits, content, force)
  }

  /**
   * Shared write path for hunk ops: diskBaseline guard → snapshot → atomic
   * write → bookkeeping (hunk state + baseline + applied transition + emit).
   */
  private async writeHunk(
    change: FileChange,
    hunks: DiffHunk[],
    applied: boolean[],
    edits: (string[] | null)[],
    content: string,
    force: boolean,
  ): Promise<ApplyResult> {
    const fs = this.ctx.get('fs')
    const snapshots: SnapshotService | undefined = this.ctx.get('snapshots')
    if (fs === undefined || snapshots === undefined) {
      return { kind: 'error', message: 'apply engine unavailable (fs/snapshots not mounted)' }
    }
    try {
      const target = await fs.resolve(change.path, {
        cwd: change.cwd.length > 0 ? change.cwd : undefined,
      })
      const info = await fs.stat(target)
      const currentText = info !== undefined ? await fs.readText(target) : undefined
      if (!force) {
        const baseline = change.diskBaseline !== undefined ? change.diskBaseline : change.after
        if ((info !== undefined) !== (baseline !== null)) {
          return { kind: 'conflict', currentHash: info !== undefined ? sha256(currentText ?? '') : 'missing', beforeHash: baseline === null ? 'absent' : sha256(baseline) }
        }
        if (info !== undefined && sha256(currentText ?? '') !== sha256(baseline ?? '')) {
          return { kind: 'conflict', currentHash: sha256(currentText ?? ''), beforeHash: sha256(baseline ?? '') }
        }
      }
      await snapshots.snapshot(change)
      await fs.writeText(target, content, undefined, undefined, workspaceWritePolicy(change.cwd))
      change.hunkApplied = applied
      change.hunkEdits = edits
      change.diskBaseline = content
      if (change.status !== 'applied') {
        this.transition(change.id, 'applied')
      }
      this.persist()
      this.ctx.emit('change.updated', change)
      return { kind: 'applied', operation: 'update' }
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Roll a change back to its pre-apply content, returning it to pending.
   */
  async rollback(id: string): Promise<RollbackResult> {
    const change = this.changes.get(id)
    if (change === undefined) {
      return { kind: 'error', message: `unknown change "${id}"` }
    }
    const snapshots: SnapshotService | undefined = this.ctx.get('snapshots')
    if (snapshots === undefined) {
      return { kind: 'error', message: 'snapshot service unavailable (SnapshotService not mounted)' }
    }
    const result = await snapshots.rollback(change)
    if (result.kind === 'rolled-back') {
      // 3.x:回滚后磁盘 = before(创建 → 文件不存在)。
      change.diskBaseline = change.operation === 'create' ? null : change.before
      // 回滚 = 全部块撤销,并丢弃块内编辑;再「应用」时回到原始 after。
      if (change.hunkApplied !== undefined || change.hunkEdits !== undefined) {
        const hunks = change.before !== null && change.after !== null ? diffHunks(change.before, change.after) : []
        change.hunkApplied = hunks.map(() => false)
        change.hunkEdits = undefined
      }
      this.transition(id, 'rolled_back')
      this.ctx.emit('change.updated', change)
    }
    return result
  }

  /**
   * Roll back every APPLIED FILE change in a session (the counterpart to
   * applyAllPending). Command/external changes are markers — they
   * never wrote to the workspace, so there is nothing to restore and no
   * snapshot exists; they are skipped rather than reported as missing.
   * Failures and missing snapshots do not interrupt the rest.
   */
  async rollbackAll(sessionId: string): Promise<RollbackAllResult> {
    const result: RollbackAllResult = { rolledBack: [], missing: [], failed: [] }
    for (const change of this.listBySession(sessionId)) {
      if (change.status !== 'applied') continue
      if (change.kind !== 'file') continue
      const outcome = await this.rollback(change.id)
      if (outcome.kind === 'rolled-back') {
        result.rolledBack.push(change.id)
      } else if (outcome.kind === 'missing-snapshot') {
        result.missing.push(change.id)
      } else {
        result.failed.push({ id: change.id, message: outcome.message })
      }
    }
    return result
  }

  /**
   * Replace a change's `after` text (editor edits), recompute the diff, and
   * reset review status to pending. Editing an APPLIED change is refused:
   * the workspace already holds the old content, so a silent `after` change
   * would desync the record from disk — roll back first.
   */
  edit(id: string, after: string): FileChange | ActionError {
    const change = this.changes.get(id)
    if (change === undefined) {
      return actionError(new Error(`change-center: unknown change "${id}"`))
    }
    if (change.status === 'applied') {
      return actionError(new Error(`change-center: cannot edit "${id}" while applied — roll back first`))
    }
    change.after = after
    change.diff = renderUnified(change.before, change.after)
    change.status = 'pending'
    // 全文编辑替换了 after ⇒ hunk 结构整体重算,块级状态作废。
    change.hunkApplied = undefined
    change.hunkEdits = undefined
    change.updatedAt = Date.now()
    this.persist()
    return change
  }

  /**
   * 4.6 Conflict Center — 用户明确选择的版本写入磁盘(force,跳过守卫):
   * 采用 Agent / 保留我的(拒绝)/ 合并文本都经此落地。写入前更新 after 与 diff,
   * 使 rollback 语义与「用户编辑后应用」一致。
   */
  async resolve(id: string, content: string): Promise<ApplyResult> {
    const change = this.changes.get(id)
    if (change === undefined) {
      return { kind: 'error', message: `unknown change "${id}"` }
    }
    if (change.status === 'applied') {
      return { kind: 'error', message: `change "${id}" is already applied` }
    }
    change.after = content
    change.diff = renderUnified(change.before, change.after)
    // 冲突中心写入的是整份新版本 ⇒ hunk 结构重算,块级状态作废。
    change.hunkApplied = undefined
    change.hunkEdits = undefined
    change.updatedAt = Date.now()
    this.persist()
    // force:用户已在冲突中心明确选择,不再需要守卫。
    return this.apply(id, true)
  }

  /**
   * Apply every pending change in a session (「全部应用」). File changes go
   * through the apply/snapshot engines; command/external changes are marked
   * applied without re-running them. Failures do not interrupt the rest;
   * already-applied or non-pending changes are reported as skipped.
   *
   * Changes are processed newest-first with one change per path: superseded
   * writes to the same file (the review surface shows only the latest) are
   * reported as `superseded` so a bulk apply never re-writes an older
   * intermediate state, and the result counters stay disjoint.
   *
   * Policy gating: when the policy engine is mounted, a pending change hit by
   * a `deny` policy is NOT applied — it stays pending and lands in `blocked`
   * (the user can adjust the policy or handle the change individually).
   *
   * @param force - bypass the deny gate and the external-modification guard
   *   (Vibe UI 「仍然全部应用」); mirrors the single-change `apply(force)`.
   */
  async applyAllPending(sessionId: string, force = false): Promise<ApplyAllResult> {
    const result: ApplyAllResult = { applied: [], skipped: [], superseded: [], failed: [], blocked: [], prepared: 0 }
    const seenPaths = new Set<string>()
    const policies = this.ctx.get('policies')
    const applyEngine: ApplyService | undefined = this.ctx.get('applyEngine')
    const pendingList: FileChange[] = []
    // Phase A — Prepare:去重、跳过、策略、hash 预检全部先做完,任何冲突在写盘前暴露。
    for (const change of this.listBySession(sessionId)) {
      if (seenPaths.has(change.path)) {
        result.superseded.push(change.id)
        continue
      }
      seenPaths.add(change.path)
      if (change.status !== 'pending') {
        result.skipped.push(change.id)
        continue
      }
      if (!force && policies !== undefined) {
        const evaluations = await policies.evaluate([change])
        const denial = evaluations.find(evaluation => evaluation.action === 'deny')
        if (denial !== undefined) {
          result.blocked.push({ id: change.id, message: `${denial.policyId}: ${denial.reason}` })
          continue
        }
      }
      // 4.5:文件变更先 preview(不写盘);冲突直接标记 failed,不进入执行。
      if (change.kind === 'file' && applyEngine !== undefined) {
        const preview = await applyEngine.preview(change, force)
        if (preview.kind === 'conflict') {
          this.transition(change.id, 'failed')
          this.ctx.emit('change.updated', change, 'external modification detected')
          result.failed.push({
            id: change.id,
            message: `external modification detected (current ${preview.currentHash.slice(0, 8)} ≠ expected ${preview.beforeHash.slice(0, 8)})`,
          })
          continue
        }
        if (preview.kind === 'error') {
          // 与冲突分支一致:预检失败也标记 failed,避免变更停留 pending。
          this.transition(change.id, 'failed')
          this.ctx.emit('change.updated', change, preview.message)
          result.failed.push({ id: change.id, message: preview.message })
          continue
        }
      }
      pendingList.push(change)
    }
    result.prepared = pendingList.length
    // Phase B — Commit:只执行通过预检的变更(pending 直接 apply)。
    for (const change of pendingList) {
      const outcome = await this.apply(change.id, force)
      if (outcome.kind === 'applied') {
        result.applied.push(change.id)
      } else {
        const message = outcome.kind === 'conflict'
          ? `external modification detected (current ${outcome.currentHash.slice(0, 8)} ≠ expected ${outcome.beforeHash.slice(0, 8)})`
          : outcome.message
        result.failed.push({ id: change.id, message })
      }
    }
    return result
  }

  /**
   * 4.7 Change Analytics:在持久化的变更存储上做轻量聚合
   * (`windowMs` 省略 = 全部历史;如 7 天)。
   */
  analytics(windowMs?: number): ChangeAnalytics {
    const cutoff = windowMs !== undefined ? Date.now() - windowMs : 0
    const files = new Set<string>()
    let applied = 0
    let failed = 0
    let rollbacks = 0
    const fileCounts = new Map<string, number>()
    for (const change of this.list()) {
      if (change.kind !== 'file' || change.createdAt < cutoff) continue
      files.add(change.path)
      if (change.status === 'applied') applied++
      else if (change.status === 'failed') failed++
      else if (change.status === 'rolled_back') rollbacks++
      fileCounts.set(change.path, (fileCounts.get(change.path) ?? 0) + 1)
    }
    const total = applied + failed
    return {
      files: files.size,
      applied,
      failed,
      successRate: total > 0 ? Math.round((applied / total) * 100) : 0,
      rollbacks,
      topFiles: [...fileCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([path, count]) => ({ path, count })),
    }
  }
}

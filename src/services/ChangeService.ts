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

  /**
   * Record a captured change and emit `change.created`.
   *
   * capture 即登记(5.x 流程收敛):agent 的工具已把文件写盘(磁盘 = after),
   * 因此记录直接标记 `applied` 并建立 before 快照 —— 回滚随时可用,
   * 不再需要「应用」按钮做确认登记。同一会话内对同一文件的多次写入会
   * **合并**为一条记录:保留最初的 `before`,`after`/`diff` 更新为最新写入,
   * 块级状态作废。评审面按路径只显示最新一条,合并避免记录堆积。
   */
  record(input: NewFileChange): FileChange {
    void this.ensureLoaded()
    const kind = input.kind ?? 'file'
    // Merge:同会话同路径的文件写入 → 更新已有记录(保持 applied + 快照)。
    if (kind === 'file') {
      for (const existing of this.changes.values()) {
        if (existing.kind !== 'file' || existing.sessionId !== input.sessionId || existing.path !== input.path) continue
        existing.after = input.after
        existing.diff = renderUnified(existing.before, existing.after)
        existing.diskBaseline = input.after
        // diff 变了 → 块级应用/编辑状态作废。
        existing.hunkApplied = undefined
        existing.hunkEdits = undefined
        existing.status = 'applied'
        existing.source = input.source
        existing.toolName = input.toolName
        existing.toolCallId = input.toolCallId
        existing.updatedAt = Date.now()
        this.captureSnapshot(existing)
        this.ctx.emit('change.updated', existing)
        this.persist()
        return existing
      }
    }
    const change: FileChange = {
      id: `change-${this.nextId++}`,
      sessionId: input.sessionId,
      cwd: input.cwd,
      kind,
      path: input.path,
      operation: input.operation,
      before: input.before,
      after: input.after,
      // 3.x:捕获发生在工具写盘之后,已知磁盘状态 = after(命令/外部记录无磁盘态)。
      diskBaseline: kind === 'file' ? input.after : undefined,
      diff: renderUnified(input.before, input.after),
      // 5.x:capture 即登记 —— 文件已由 agent 写盘,直接视为已应用。
      status: 'applied',
      source: input.source,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.changes.set(change.id, change)
    // 5.x:捕获时建立 before 快照(best-effort,失败则回滚报 missing-snapshot)。
    if (kind === 'file') this.captureSnapshot(change)
    this.ctx.emit('change.created', change)
    this.persist()
    return change
  }

  /** 建 before 快照(best-effort):回滚恢复 `change.before`,与磁盘内容无关。 */
  private captureSnapshot(change: FileChange): void {
    const snapshots: SnapshotService | undefined = this.ctx.get('snapshots')
    if (snapshots === undefined) return
    void snapshots.snapshot(change).catch(() => undefined)
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
   * 写盘核心(私有):hash 守卫(外部修改不覆盖)→ 快照 → 引擎原子写 → 更新基线。
   * 被「编辑保存(saveEdit)」「冲突中心 resolve」复用。5.x 起 capture 即登记,
   * 不存在「确认登记型」的应用操作 —— 所有写盘都来自用户显式修改(编辑/hunk/
   * 恢复/回滚)。
   * @param force - 绕过外部修改守卫(冲突中心「强制写入」)。
   * @returns 引擎结果;conflict 时保持原状态,由 UI 提示。
   */
  private async writeBack(change: FileChange, force = false): Promise<ApplyResult> {
    const applyEngine: ApplyService | undefined = this.ctx.get('applyEngine')
    const snapshots: SnapshotService | undefined = this.ctx.get('snapshots')
    if (applyEngine === undefined || snapshots === undefined) {
      return { kind: 'error', message: 'write-back engine unavailable (ApplyService/SnapshotService not mounted)' }
    }
    try {
      await snapshots.snapshot(change)
      const result = await applyEngine.apply(change, force)
      if (result.kind === 'applied') {
        // 应用成功后,已知磁盘状态 = 当前 after(删除 → 文件不存在)。
        change.diskBaseline = change.operation === 'delete' ? null : change.after
        if (change.status !== 'applied') this.transition(change.id, 'applied')
        else change.updatedAt = Date.now()
        this.persist()
        this.ctx.emit('change.updated', change)
      }
      // conflict / error:保持原状态不覆盖,UI 展示冲突与处理入口。
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', message }
    }
  }

  /**
   * 编辑保存 = 一步写盘:更新 after/diff,经 hash 守卫 + 引擎原子写,保持 applied。
   * 冲突时返回 conflict(UI 提示「查看差异/强制写入」),不自动覆盖外部修改。
   */
  async saveEdit(id: string, after: string, force = false): Promise<ApplyResult> {
    const change = this.changes.get(id)
    if (change === undefined) {
      return { kind: 'error', message: `unknown change "${id}"` }
    }
    if (change.kind !== 'file') {
      return { kind: 'error', message: `change "${id}" is not a file change` }
    }
    change.after = after
    change.diff = renderUnified(change.before, change.after)
    change.hunkApplied = undefined
    change.hunkEdits = undefined
    change.updatedAt = Date.now()
    this.persist()
    return this.writeBack(change, force)
  }

  /**
   * 恢复(撤销回滚):rolled_back → 把 agent 版本(after)写回磁盘并重新登记 applied。
   * 守卫使用回滚后的磁盘基线(before),磁盘未被外部修改时直接通过。
   */
  async restore(id: string): Promise<ApplyResult> {
    const change = this.changes.get(id)
    if (change === undefined) {
      return { kind: 'error', message: `unknown change "${id}"` }
    }
    if (change.kind !== 'file') {
      return { kind: 'error', message: `change "${id}" is not a file change` }
    }
    return this.writeBack(change)
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
   * 4.6 Conflict Center — 用户明确选择的版本写入磁盘(force,跳过守卫):
   * 采用 Agent / 合并文本都经此落地。写入前更新 after 与 diff,
   * 使 rollback 语义与「编辑保存」一致。
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
    return this.writeBack(change, true)
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

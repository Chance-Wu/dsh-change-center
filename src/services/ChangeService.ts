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
import { renderUnified } from './DiffService.ts'
import { JsonlStore, maxIdSuffix } from './JsonlStore.ts'
import type { ApplyService, ApplyResult } from './ApplyService.ts'
import type { SnapshotService, RollbackResult } from './SnapshotService.ts'

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

/** Result of {@link ChangeService.acceptAllAndApply}. */
export interface AcceptAllResult {
  /** Changes approved (pending → approved). */
  approved: string[]
  /** Approved changes successfully applied (incl. command/external). */
  applied: string[]
  /** Changes skipped (not pending / already applied). */
  skipped: string[]
  /** Changes that failed to apply, with a reason. */
  failed: { id: string; message: string }[]
}

/** Valid transition map of the review state machine. */
const TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  // failed covers apply-attempt failures from any reviewable state.
  pending: ['approved', 'rejected', 'applied', 'failed'],
  approved: ['applied', 'rejected', 'pending', 'failed'],
  rejected: ['pending'],
  applied: ['pending', 'rolled_back'],
  failed: ['pending', 'applied', 'approved', 'rejected'],
  rolled_back: ['pending'],
}

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

  /** Record a captured change and emit `change:created`. */
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
      diff: renderUnified(input.before, input.after),
      status: 'pending',
      source: input.source,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.changes.set(change.id, change)
    this.ctx.emit('change:created', change)
    this.persist()
    return change
  }

  /** All recorded changes, newest first. */
  list(): FileChange[] {
    void this.ensureLoaded()
    return [...this.changes.values()].sort((a, b) => b.createdAt - a.createdAt)
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

  approve(id: string): FileChange {
    const change = this.transition(id, 'approved')
    this.ctx.emit('change:approved', change)
    return change
  }

  reject(id: string): FileChange {
    const change = this.transition(id, 'rejected')
    this.ctx.emit('change:rejected', change)
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
      this.ctx.emit('change:applied', change)
      return { kind: 'applied', operation: 'execute' }
    }
    const applyEngine: ApplyService | undefined = this.ctx.get('applyEngine')
    const snapshots: SnapshotService | undefined = this.ctx.get('snapshots')
    if (applyEngine === undefined || snapshots === undefined) {
      const message = 'apply engine unavailable (ApplyService/SnapshotService not mounted)'
      this.transition(id, 'failed')
      this.ctx.emit('change:failed', change, message)
      return { kind: 'error', message }
    }
    try {
      await snapshots.snapshot(change)
      const result = await applyEngine.apply(change, force)
      if (result.kind === 'applied') {
        this.transition(id, 'applied')
        this.ctx.emit('change:applied', change)
      } else if (result.kind === 'conflict') {
        this.transition(id, 'failed')
        this.ctx.emit('change:failed', change, 'external modification detected')
      } else {
        this.transition(id, 'failed')
        this.ctx.emit('change:failed', change, result.message)
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.transition(id, 'failed')
      this.ctx.emit('change:failed', change, message)
      return { kind: 'error', message }
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
      this.transition(id, 'rolled_back')
      this.ctx.emit('change:rollback', change)
    }
    return result
  }

  /**
   * Replace a change's `after` text (editor edits), recompute the diff, and
   * reset review status to pending. Editing an APPLIED change is refused:
   * the workspace already holds the old content, so a silent `after` change
   * would desync the record from disk — roll back first.
   */
  edit(id: string, after: string): FileChange {
    const change = this.changes.get(id)
    if (change === undefined) {
      throw new Error(`change-center: unknown change "${id}"`)
    }
    if (change.status === 'applied') {
      throw new Error(`change-center: cannot edit "${id}" while applied — roll back first`)
    }
    change.after = after
    change.diff = renderUnified(change.before, change.after)
    change.status = 'pending'
    change.updatedAt = Date.now()
    this.persist()
    return change
  }

  /** Approve every pending change in a session. */
  approveAll(sessionId: string): FileChange[] {
    const updated: FileChange[] = []
    for (const change of this.listBySession(sessionId)) {
      if (change.status === 'pending') updated.push(this.approve(change.id))
    }
    return updated
  }

  /** Reject every pending change in a session. */
  rejectAll(sessionId: string): FileChange[] {
    const updated: FileChange[] = []
    for (const change of this.listBySession(sessionId)) {
      if (change.status === 'pending') updated.push(this.reject(change.id))
    }
    return updated
  }

  /**
   * Accept-and-apply every pending change in a session: approve each pending
   * change, then apply it (command/external changes are marked applied; file
   * changes need the apply/snapshot engines). Failures do not interrupt the
   * rest; already-applied or non-pending changes are reported as skipped.
   *
   * Changes are processed newest-first with one change per path: superseded
   * writes to the same file (the review surface shows only the latest) are
   * skipped so a bulk apply never re-writes an older intermediate state.
   */
  async acceptAllAndApply(sessionId: string): Promise<AcceptAllResult> {
    const result: AcceptAllResult = { approved: [], applied: [], skipped: [], failed: [] }
    const seenPaths = new Set<string>()
    for (const change of this.listBySession(sessionId)) {
      if (seenPaths.has(change.path)) {
        result.skipped.push(change.id)
        continue
      }
      seenPaths.add(change.path)
      if (change.status !== 'pending') {
        result.skipped.push(change.id)
        continue
      }
      this.approve(change.id)
      result.approved.push(change.id)
      const outcome = await this.apply(change.id)
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
}

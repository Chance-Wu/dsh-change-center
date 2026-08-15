/**
 * Apply engine: writes an approved change back to the workspace.
 *
 * Capture runs AFTER the tool already wrote the file (the `tools/result`
 * hook sees the post-write state), so the on-disk content at capture time
 * equals `change.after`. The external-mutation guard therefore compares the
 * CURRENT on-disk content against `change.after`: a match means nobody
 * touched the file since capture (re-applying the same content is a safe
 * no-op write), and a mismatch means an external edit happened between
 * capture and apply — which must not be silently overwritten. On mismatch
 * the apply fails with a `conflict` unless forced.
 *
 * Writes go through `ctx.fs.writeText` — the local backend's staging +
 * rename atomic write — so a partially-failed apply never corrupts the file.
 * @module dsh-change-center/services
 */

import { createHash } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.fs` Context merge into scope.
import type {} from '@deepseek-ai/dsh-fs'
import type { FileChange } from '../models/FileChange.ts'
import { workspaceWritePolicy } from './pluginFs.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    applyEngine: ApplyService
  }
}

/** Result of one apply attempt. */
export type ApplyResult =
  | { kind: 'applied'; operation: 'create' | 'update' | 'delete' | 'execute' }
  | { kind: 'conflict'; currentHash: string; beforeHash: string }
  | { kind: 'error'; message: string }

/** SHA-256 hex digest of a string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The apply engine: content-hash guard + atomic write-back through `ctx.fs`.
 * Injected under the `applyEngine` name; consumed by the change store.
 */
export class ApplyService extends Service {
  static inject = ['fs']

  constructor(ctx: Context) {
    super(ctx, 'applyEngine')
  }

  /**
   * Apply one change to the workspace.
   * @param change - the change to write back.
   * @param force - bypass the external-mutation guard.
   */
  async apply(change: FileChange, force = false): Promise<ApplyResult> {
    const target = await this.resolve(change)
    const current = await this.ctx.fs.stat(target)
    const currentText = current !== undefined ? await this.ctx.fs.readText(target) : undefined

    // A captured delete removes the file; the guard still applies.
    if (change.operation === 'delete') {
      const conflict = this.guardConflict(change, currentText, current !== undefined, force)
      if (conflict !== undefined) return conflict
      if (current !== undefined) {
        // ctx.fs has no unlink; the local backend resolves through fsio which
        // wraps fs operations — remove via the target's process path.
        const { unlink } = await import('node:fs/promises')
        await unlink(this.ctx.fs.processPath(target))
      }
      return { kind: 'applied', operation: 'delete' }
    }

    const conflict = this.guardConflict(change, currentText, current !== undefined, force)
    if (conflict !== undefined) return conflict

    // The write-back lands in the session's own workspace: root the fence at
    // change.cwd explicitly, or an agentless call falls back to the process
    // cwd and a default web boot denies the write.
    const outcome = await this.ctx.fs.writeText(
      target,
      change.after ?? '',
      undefined,
      undefined,
      workspaceWritePolicy(change.cwd),
    )
    return { kind: 'applied', operation: outcome.operation }
  }

  private async resolve(change: FileChange) {
    return this.ctx.fs.resolve(change.path, {
      cwd: change.cwd.length > 0 ? change.cwd : undefined,
    })
  }

  /**
   * Compare the on-disk content against the captured final state
   * (`change.after`). Returns a conflict result when they differ and force
   * is not set.
   */
  private guardConflict(
    change: FileChange,
    currentText: string | undefined,
    exists: boolean,
    force: boolean,
  ): ApplyResult | undefined {
    if (force) return undefined
    // A captured create leaves the file present with the after content; a
    // captured modify leaves it present with the after content too. The file
    // must still hold that content (no external edit since capture).
    if (!exists && change.operation !== 'delete') {
      // The file vanished after capture — treat as an external change.
      return { kind: 'conflict', currentHash: 'missing', beforeHash: sha256(change.after ?? '') }
    }
    const currentHash = sha256(currentText ?? '')
    const afterHash = sha256(change.after ?? '')
    if (currentHash !== afterHash) {
      return { kind: 'conflict', currentHash, beforeHash: afterHash }
    }
    return undefined
  }
}

/**
 * Snapshot service: captures the pre-change workspace state of each change
 * and restores it on rollback.
 *
 * Capture runs after the tool already wrote the file, so the true "before"
 * state of the workspace is `change.before` — the snapshot stores that text
 * (or records absence for a create). Rolling back writes it back through
 * `ctx.fs`, and the change returns to `pending` so it can be re-applied or
 * edited.
 *
 * All persistence goes through the `ctx.fs` seam (the same sandbox/approval/
 * atomic-write path ApplyService uses): snapshots live under
 * `$DSH_HOME/change-center/snapshots/<sessionId>/<changeId>/` — one content
 * file per change; an absent pre-change file records an `absent` marker.
 * @module dsh-change-center/services
 */

import { rm, stat as statPath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
// Type-only: pulls the `ctx.fs` Context merge into scope.
import type {} from '@deepseek-ai/dsh-fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { FileChange } from '../models/FileChange.ts'
import { PLUGIN_STATE_POLICY, workspaceWritePolicy } from './pluginFs.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    snapshots: SnapshotService
  }
}

/** Result of one rollback attempt. */
export type RollbackResult =
  | { kind: 'rolled-back' }
  | { kind: 'missing-snapshot'; path: string }
  | { kind: 'error'; message: string }

/**
 * Disk snapshot store for applied changes, persisted through the `ctx.fs`
 * seam.
 */
export class SnapshotService extends Service {
  static inject = ['fs']

  /** Root directory for all change-center snapshots. */
  private readonly root: string
  /** Stale snapshots (older than this) are swept once per service lifetime. */
  private readonly ttlMs: number
  /** Per-agent-session cap: keep the newest N snapshot dirs (S-5). */
  private readonly perSessionKeep: number
  private sweepStarted = false

  constructor(ctx: Context, config: { ttlMs?: number; perSessionKeep?: number } = {}) {
    super(ctx, 'snapshots')
    this.root = join(resolveDshHome(), 'change-center', 'snapshots')
    this.ttlMs = config.ttlMs ?? 7 * 24 * 60 * 60 * 1000
    this.perSessionKeep = config.perSessionKeep ?? 30
  }

  /**
   * Capture a change's pre-change state. The snapshot stores `change.before`
   * (the true workspace state before the tool ran); a create (before null)
   * records absence — an `absent` marker is written, and rollback removes the
   * file.
   * @param change - the change about to be applied.
   */
  async snapshot(change: FileChange): Promise<void> {
    this.sweepStale()
    const dir = this.dirFor(change)
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      throw new Error('snapshot: fs service unavailable')
    }
    if (change.before === null) {
      // Create: record absence so rollback knows to delete the file.
      // Snapshots live under $DSH_HOME — plugin state, outside the session
      // sandbox; without the explicit policy a default web boot denies this
      // write and every file apply fails before it writes back.
      await fs.writeText(await fs.resolve(join(dir, 'absent')), '', undefined, undefined, PLUGIN_STATE_POLICY)
    } else {
      await fs.writeText(await fs.resolve(this.fileFor(change)), change.before, undefined, undefined, PLUGIN_STATE_POLICY)
    }
    // S-5:每 agent 会话快照数设上限,只留最新的 N 个,磁盘有界。
    await this.pruneSession(change.sessionId, this.perSessionKeep)
  }

  /**
   * Prune one agent session's snapshot dir down to the newest `keep` entries
   * (by mtime). Best-effort; never throws. Snapshot dirs are named by the
   * change id and stored under `<root>/<safe sessionId>/`.
   */
  async pruneSession(sessionId: string, keep = 5): Promise<void> {
    const fs = this.ctx.get('fs')
    if (fs === undefined || keep <= 0) return
    try {
      const sessionTarget = await fs.resolve(join(this.root, safe(sessionId)))
      const entries = await fs.listDir(sessionTarget)
      const dirs = entries.filter(entry => entry.type === 'directory')
      if (dirs.length <= keep) return
      const withMtime = await Promise.all(dirs.map(async entry => {
        let mtime = 0
        try {
          const info = await statPath(fs.processPath(entry.target))
          mtime = info.mtimeMs
        } catch {
          // Unreadable entries sort as oldest.
        }
        return { entry, mtime }
      }))
      withMtime.sort((a, b) => b.mtime - a.mtime)
      for (const { entry } of withMtime.slice(keep)) {
        await rm(fs.processPath(entry.target), { recursive: true, force: true })
      }
    } catch {
      // No session dir yet — nothing to prune.
    }
  }

  /**
   * Restore a change's pre-change state and return the change to pending.
   * @param change - the applied change to roll back.
   */
  async rollback(change: FileChange): Promise<RollbackResult> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      return { kind: 'error', message: 'snapshot: fs service unavailable' }
    }
    const dir = this.dirFor(change)
    const file = this.fileFor(change)
    try {
      // A create's snapshot is an `absent` marker: rollback deletes the file.
      const marker = await fs.resolve(join(dir, 'absent'))
      const markerInfo = await fs.stat(marker)
      const target = await fs.resolve(change.path, {
        cwd: change.cwd.length > 0 ? change.cwd : undefined,
      })
      if (markerInfo !== undefined) {
        const info = await fs.stat(target)
        if (info !== undefined) {
          // ctx.fs has no unlink; remove via the target's process path (the
          // target lives in the workspace, so the sandbox allows it).
          await unlink(fs.processPath(target))
        }
      } else {
        const contentTarget = await fs.resolve(file)
        const contentInfo = await fs.stat(contentTarget)
        if (contentInfo === undefined) {
          return { kind: 'missing-snapshot', path: file }
        }
        const content = await fs.readText(contentTarget)
        // Restoring writes back into the change's workspace — root the fence
        // at change.cwd (agentless calls fall back to the process cwd).
        await fs.writeText(target, content, undefined, undefined, workspaceWritePolicy(change.cwd))
      }
      // A rolled-back change no longer needs its snapshot; the next apply
      // captures a fresh one.
      await this.removeDir(fs, dir)
      return { kind: 'rolled-back' }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return { kind: 'missing-snapshot', path: file }
      }
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  private dirFor(change: FileChange): string {
    return join(this.root, safe(change.sessionId), safe(change.id))
  }

  private fileFor(change: FileChange): string {
    return join(this.dirFor(change), 'content.txt')
  }

  /** Best-effort removal of a snapshot directory via its process path. */
  private async removeDir(fs: FileSystem, dir: string): Promise<void> {
    try {
      const target = await fs.resolve(dir)
      await rm(fs.processPath(target), { recursive: true, force: true })
    } catch {
      // Best-effort: stale snapshots are also covered by the TTL sweep.
    }
  }

  /**
   * One-time sweep: remove snapshot directories older than the TTL so disk
   * use stays bounded. Runs at most once per service lifetime (on the first
   * snapshot); never throws.
   */
  private sweepStale(): void {
    if (this.sweepStarted) return
    this.sweepStarted = true
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    void (async () => {
      try {
        const rootTarget = await fs.resolve(this.root)
        const entries = await fs.listDir(rootTarget)
        const cutoff = Date.now() - this.ttlMs
        for (const entry of entries) {
          if (entry.type !== 'directory') continue
          try {
            const info = await statPath(fs.processPath(entry.target))
            if (info.mtimeMs < cutoff) {
              await rm(fs.processPath(entry.target), { recursive: true, force: true })
            }
          } catch {
            // Skip unreadable or racing entries.
          }
        }
      } catch {
        // No snapshot root yet — nothing to sweep.
      }
    })()
  }
}

/** Neutralize path separators so session/change ids cannot traverse out. */
function safe(segment: string): string {
  return segment.replace(/[/\\]/g, '_')
}

/**
 * Snapshot service (4.2 Smart Snapshot 2.0): captures the pre-change
 * workspace state of each change and restores it on rollback.
 *
 * Capture runs after the tool already wrote the file, so the true "before"
 * state of the workspace is `change.before` — the snapshot stores that text
 * (or records absence for a create). Rolling back writes it back through
 * `ctx.fs`, and the change returns to `pending` so it can be re-applied or
 * edited.
 *
 * Storage is CONTENT-ADDRESSED: identical file content is stored once under
 * `blobs/<sha256>`, and each change keeps a tiny marker
 * (`changes/<session>/<changeId>/blob` holding the hash, or `/absent` for
 * creates). Large repositories that touch the same base files repeatedly
 * therefore use far less disk. A GC pass removes blobs no marker references;
 * legacy `<root>/<session>/<changeId>/content.txt` snapshots are still
 * readable for rollback.
 *
 * All persistence goes through the `ctx.fs` seam (the same sandbox/approval/
 * atomic-write path ApplyService uses); snapshots live under
 * `$DSH_HOME/change-center/snapshots/`.
 * @module dsh-change-center/services
 */

import { createHash } from 'node:crypto'
import { rm, stat as statPath, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
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

/** SHA-256 hex digest of a string. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Disk snapshot store for applied changes, persisted through the `ctx.fs`
 * seam. Content-addressed blobs + per-change markers (4.2).
 */
export class SnapshotService extends Service {
  static inject = ['fs']

  /** Root directory for all change-center snapshots. */
  private readonly root: string
  /** Content-addressed blob store: `blobs/<sha256>`. */
  private readonly blobRoot: string
  /** Per-change markers: `changes/<safeSession>/<safeChangeId>/{blob,absent}`. */
  private readonly changeRoot: string
  /** Stale snapshots (older than this) are swept once per service lifetime. */
  private readonly ttlMs: number
  /** Per-agent-session cap: keep the newest N snapshot markers (S-5). */
  private readonly perSessionKeep: number
  private sweepStarted = false

  constructor(ctx: Context, config: { ttlMs?: number; perSessionKeep?: number } = {}) {
    super(ctx, 'snapshots')
    this.root = join(resolveDshHome(), 'change-center', 'snapshots')
    this.blobRoot = join(this.root, 'blobs')
    this.changeRoot = join(this.root, 'changes')
    this.ttlMs = config.ttlMs ?? 7 * 24 * 60 * 60 * 1000
    this.perSessionKeep = config.perSessionKeep ?? 30
  }

  /**
   * Capture a change's pre-change state (content-addressed). A create
   * (before null) records an `absent` marker; rollback then removes the file.
   * @param change - the change about to be applied.
   */
  async snapshot(change: FileChange): Promise<void> {
    this.sweepStale()
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      throw new Error('snapshot: fs service unavailable')
    }
    const markerDir = this.markerDirFor(change)
    if (change.before === null) {
      // Snapshots live under $DSH_HOME — plugin state, outside the session
      // sandbox; without the explicit policy a default web boot denies this
      // write and every file apply fails before it writes back.
      await fs.writeText(await fs.resolve(join(markerDir, 'absent')), '', undefined, undefined, PLUGIN_STATE_POLICY)
    } else {
      // 4.2:内容寻址去重 —— 相同内容只存一个 blob。
      const hash = sha256(change.before)
      // 先写 marker 再写 blob:marker 先落盘会让并发的 gcBlobs 看到引用,
      // 避免「blob 已写、marker 未写」的窗口里把刚写的 blob 当孤儿删掉。
      await fs.writeText(await fs.resolve(join(markerDir, 'blob')), hash, undefined, undefined, PLUGIN_STATE_POLICY)
      const blob = await fs.resolve(join(this.blobRoot, hash))
      if (await fs.stat(blob) === undefined) {
        await fs.writeText(blob, change.before, undefined, undefined, PLUGIN_STATE_POLICY)
      }
    }
    // S-5/4.2:每 agent 会话快照数设上限,只留最新的 N 个,磁盘有界。
    await this.pruneSession(change.sessionId, this.perSessionKeep)
  }

  /**
   * Prune one agent session's snapshot markers down to the newest `keep`
   * entries (by mtime). Best-effort; never throws.
   */
  async pruneSession(sessionId: string, keep = 5): Promise<void> {
    const fs = this.ctx.get('fs')
    if (fs === undefined || keep <= 0) return
    try {
      const sessionTarget = await fs.resolve(join(this.changeRoot, safe(sessionId)))
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
      // 4.2:清理不再被引用的 blob。
      await this.gcBlobs()
    } catch {
      // No session dir yet — nothing to prune.
    }
  }

  /**
   * Restore a change's pre-change state and return the change to pending.
   * Reads the new content-addressed marker first; falls back to the legacy
   * per-change directory layout.
   * @param change - the applied change to roll back.
   */
  async rollback(change: FileChange): Promise<RollbackResult> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      return { kind: 'error', message: 'snapshot: fs service unavailable' }
    }
    const markerDir = this.markerDirFor(change)
    const legacyDir = this.dirFor(change)
    const legacyFile = join(legacyDir, 'content.txt')
    try {
      const target = await fs.resolve(change.path, {
        cwd: change.cwd.length > 0 ? change.cwd : undefined,
      })
      // 1) 新布局:absent 标记(创建)。
      if (await fs.stat(await fs.resolve(join(markerDir, 'absent'))) !== undefined) {
        const info = await fs.stat(target)
        if (info !== undefined) {
          // ctx.fs has no unlink; remove via the target's process path (the
          // target lives in the workspace, so the sandbox allows it).
          await unlink(fs.processPath(target))
        }
        await this.removeDir(fs, markerDir)
        return { kind: 'rolled-back' }
      }
      // 2) 新布局:blob 标记(内容寻址)。
      const blobMarker = await fs.resolve(join(markerDir, 'blob'))
      if (await fs.stat(blobMarker) !== undefined) {
        const hash = (await fs.readText(blobMarker)).trim()
        const blob = await fs.resolve(join(this.blobRoot, hash))
        if (await fs.stat(blob) === undefined) {
          await this.removeDir(fs, markerDir)
          return { kind: 'missing-snapshot', path: fs.processPath(blob) }
        }
        const content = await fs.readText(blob)
        await fs.writeText(target, content, undefined, undefined, workspaceWritePolicy(change.cwd))
        await this.removeDir(fs, markerDir)
        return { kind: 'rolled-back' }
      }
      // 3) 旧布局回退:legacy `<root>/<session>/<changeId>/`。
      const absent = await fs.resolve(join(legacyDir, 'absent'))
      if (await fs.stat(absent) !== undefined) {
        const info = await fs.stat(target)
        if (info !== undefined) {
          await unlink(fs.processPath(target))
        }
        await this.removeDir(fs, legacyDir)
        return { kind: 'rolled-back' }
      }
      const contentTarget = await fs.resolve(legacyFile)
      if (await fs.stat(contentTarget) === undefined) {
        return { kind: 'missing-snapshot', path: legacyFile }
      }
      const content = await fs.readText(contentTarget)
      await fs.writeText(target, content, undefined, undefined, workspaceWritePolicy(change.cwd))
      await this.removeDir(fs, legacyDir)
      return { kind: 'rolled-back' }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return { kind: 'missing-snapshot', path: legacyFile }
      }
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 4.2 blob GC:删除任何 marker 都不再引用的 blob。返回移除数量;best-effort。
   */
  async gcBlobs(): Promise<number> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return 0
    try {
      const referenced = new Set<string>()
      await this.collectBlobRefs(fs, await fs.resolve(this.changeRoot), referenced)
      const blobsTarget = await fs.resolve(this.blobRoot)
      const entries = await fs.listDir(blobsTarget)
      let removed = 0
      for (const entry of entries) {
        if (entry.type !== 'file') continue
        if (!referenced.has(basename(fs.processPath(entry.target)))) {
          await rm(fs.processPath(entry.target), { force: true })
          removed++
        }
      }
      return removed
    } catch {
      return 0
    }
  }

  /** Recursively collect every referenced blob hash from `blob` markers. */
  private async collectBlobRefs(fs: FileSystem, dirTarget: FsTarget, out: Set<string>): Promise<void> {
    let entries: Awaited<ReturnType<FileSystem['listDir']>>
    try {
      entries = await fs.listDir(dirTarget)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.type === 'directory') {
        await this.collectBlobRefs(fs, entry.target, out)
      } else if (basename(fs.processPath(entry.target)) === 'blob') {
        try {
          const hash = (await fs.readText(entry.target)).trim()
          if (hash.length > 0) out.add(hash)
        } catch {
          // Unreadable marker: ignore.
        }
      }
    }
  }

  private markerDirFor(change: FileChange): string {
    return join(this.changeRoot, safe(change.sessionId), safe(change.id))
  }

  /** Legacy layout (pre-4.2): `<root>/<safeSessionId>/<safeChangeId>/`. */
  private dirFor(change: FileChange): string {
    return join(this.root, safe(change.sessionId), safe(change.id))
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
   * One-time sweep: remove stale legacy dirs + new-layout markers older than
   * the TTL, then GC orphaned blobs. Runs at most once per service lifetime
   * (on the first snapshot); never throws.
   */
  private sweepStale(): void {
    if (this.sweepStarted) return
    this.sweepStarted = true
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    void (async () => {
      try {
        const cutoff = Date.now() - this.ttlMs
        const rootTarget = await fs.resolve(this.root)
        const entries = await fs.listDir(rootTarget)
        for (const entry of entries) {
          if (entry.type !== 'directory') continue
          const name = basename(fs.processPath(entry.target))
          // blobs/ 与 changes/ 是新布局的专用目录,不在旧的「会话目录」语义内。
          if (name === 'blobs' || name === 'changes') continue
          try {
            const info = await statPath(fs.processPath(entry.target))
            if (info.mtimeMs < cutoff) {
              await rm(fs.processPath(entry.target), { recursive: true, force: true })
            }
          } catch {
            // Skip unreadable or racing entries.
          }
        }
        // 新布局:按 marker 目录 mtime 清理。
        await this.sweepChangeTree(fs, await fs.resolve(this.changeRoot), cutoff)
        await this.gcBlobs()
      } catch {
        // No snapshot root yet — nothing to sweep.
      }
    })()
  }

  /** Remove new-layout change markers older than the cutoff. */
  private async sweepChangeTree(fs: FileSystem, changeRootTarget: FsTarget, cutoff: number): Promise<void> {
    try {
      const sessionEntries = await fs.listDir(changeRootTarget)
      for (const sessionEntry of sessionEntries) {
        if (sessionEntry.type !== 'directory') continue
        const changeEntries = await fs.listDir(sessionEntry.target)
        for (const changeEntry of changeEntries) {
          if (changeEntry.type !== 'directory') continue
          try {
            const info = await statPath(fs.processPath(changeEntry.target))
            if (info.mtimeMs < cutoff) {
              await rm(fs.processPath(changeEntry.target), { recursive: true, force: true })
            }
          } catch {
            // Skip unreadable or racing entries.
          }
        }
      }
    } catch {
      // No change tree yet.
    }
  }
}

/** Neutralize path separators so session/change ids cannot traverse out. */
function safe(segment: string): string {
  return segment.replace(/[/\\]/g, '_')
}

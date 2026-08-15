/**
 * SnapshotService TTL sweep tests: stale snapshot directories older than the
 * TTL are removed once per service lifetime (on the first snapshot), while
 * fresh ones survive.
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SnapshotService } from '../src/services/SnapshotService.ts'
import type { FileChange } from '../src/models/FileChange.ts'
import { removeDirSafe } from './helpers/removeDir.ts'

let tempRoot: string

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'dsh-sweep-'))
  process.env.DSH_HOME = tempRoot
})

afterAll(async () => {
  delete process.env.DSH_HOME
  await removeDirSafe(tempRoot)
})

function change(id: string, sessionId: string, before: string | null): FileChange {
  return {
    id, sessionId, cwd: tempRoot, kind: 'file',
    path: `${id}.txt`, operation: before === null ? 'create' : 'modify',
    before, after: 'new\n', diff: '+new\n', status: 'pending',
    source: 'agent', toolName: 'edit', createdAt: 0, updatedAt: 0,
  }
}

describe('SnapshotService TTL sweep', () => {
  it('removes stale snapshots and keeps fresh ones', async () => {
    const snapRoot = join(tempRoot, 'change-center', 'snapshots')
    const sessionDir = join(snapRoot, 'old-session')
    const staleDir = join(sessionDir, 'change-1')
    const staleFile = join(staleDir, 'content.txt')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(staleFile, 'stale')
    const old = new Date(Date.now() - 10 * 60 * 1000)
    // The sweep's TTL check targets the session dir directly under the
    // snapshots root; age it (and its subtree) on the canonical path, since
    // tmpdir's /var symlink on macOS does not reliably apply utimes to the
    // inode the fs seam lists.
    utimesSync(realpathSync(sessionDir), old, old)
    utimesSync(realpathSync(staleDir), old, old)
    utimesSync(realpathSync(staleFile), old, old)

    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(SnapshotService, { ttlMs: 60_000 })
    // The first snapshot triggers the one-time sweep.
    await ctx.snapshots.snapshot(change('change-new', 'new-session', 'old\n'))

    // Sweep is fire-and-forget; give it a tick.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(existsSync(sessionDir)).toBe(false)
    expect(existsSync(join(snapRoot, 'new-session', 'change-new', 'content.txt'))).toBe(true)
  })

  it('pruneSession keeps only the newest N snapshot dirs per session (S-5)', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(SnapshotService)
    // 预置 5 个快照目录,按 mtime 从旧到新。
    const sessionDir = join(tempRoot, 'change-center', 'snapshots', 'sess-1')
    for (let i = 1; i <= 5; i++) {
      const dir = join(sessionDir, `change-${i}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'content.txt'), `v${i}`)
      const stamp = new Date(Date.now() - (6 - i) * 60_000)
      utimesSync(realpathSync(dir), stamp, stamp)
    }
    await ctx.snapshots.pruneSession('sess-1', 2)
    // 最新 2 个(change-5、change-4)保留,其余删除。
    expect(existsSync(join(sessionDir, 'change-5', 'content.txt'))).toBe(true)
    expect(existsSync(join(sessionDir, 'change-4', 'content.txt'))).toBe(true)
    expect(existsSync(join(sessionDir, 'change-3'))).toBe(false)
    expect(existsSync(join(sessionDir, 'change-2'))).toBe(false)
    expect(existsSync(join(sessionDir, 'change-1'))).toBe(false)
  })
})

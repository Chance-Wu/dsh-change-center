/**
 * SnapshotService TTL sweep tests: stale snapshot directories older than the
 * TTL are removed once per service lifetime (on the first snapshot), while
 * fresh ones survive.
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs'
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
    // 4.2 新布局:内容寻址 marker(`changes/<session>/<changeId>/blob`),blob 在 blobs/ 下。
    expect(existsSync(join(snapRoot, 'changes', 'new-session', 'change-new', 'blob'))).toBe(true)
  })

  it('pruneSession keeps only the newest N snapshot markers per session (S-5)', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(SnapshotService)
    // 预置 5 个 marker 目录(4.2 新布局),按 mtime 从旧到新。
    const sessionDir = join(tempRoot, 'change-center', 'snapshots', 'changes', 'sess-1')
    for (let i = 1; i <= 5; i++) {
      const dir = join(sessionDir, `change-${i}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'blob'), `hash-${i}`)
      const stamp = new Date(Date.now() - (6 - i) * 60_000)
      utimesSync(realpathSync(dir), stamp, stamp)
    }
    await ctx.snapshots.pruneSession('sess-1', 2)
    // 最新 2 个(change-5、change-4)保留,其余删除。
    expect(existsSync(join(sessionDir, 'change-5', 'blob'))).toBe(true)
    expect(existsSync(join(sessionDir, 'change-4', 'blob'))).toBe(true)
    expect(existsSync(join(sessionDir, 'change-3'))).toBe(false)
    expect(existsSync(join(sessionDir, 'change-2'))).toBe(false)
    expect(existsSync(join(sessionDir, 'change-1'))).toBe(false)
  })

  it('snapshot is content-addressed: identical content is stored once (4.2)', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(SnapshotService)
    const shared = 'same content\n'
    // 两个不同变更,相同的 before → 只应有一个 blob 存这份内容。
    await ctx.snapshots.snapshot(change('a-1', 'dedupe-s', shared))
    await ctx.snapshots.snapshot(change('b-1', 'dedupe-s', shared))
    const blobsDir = join(tempRoot, 'change-center', 'snapshots', 'blobs')
    // 目录里可能还有其他测试的 blob;只统计内容为 shared 的。
    const sharedBlobCount = existsSync(blobsDir)
      ? readdirSync(blobsDir)
        .filter(name => !name.startsWith('.'))
        .filter(name => readFileSync(join(blobsDir, name), 'utf8') === shared)
        .length
      : 0
    expect(sharedBlobCount).toBe(1)
    // 两个 marker 都引用同一个 hash。
    const markerA = readFileSync(join(tempRoot, 'change-center', 'snapshots', 'changes', 'dedupe-s', 'a-1', 'blob'), 'utf8')
    const markerB = readFileSync(join(tempRoot, 'change-center', 'snapshots', 'changes', 'dedupe-s', 'b-1', 'blob'), 'utf8')
    expect(markerA.trim()).toBe(markerB.trim())
  })

  it('gcBlobs removes blobs no marker references (4.2)', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(SnapshotService)
    // 一个被引用的 blob + 一个孤儿 blob。
    await ctx.snapshots.snapshot(change('keep-1', 'gc-s', 'kept\n'))
    const blobsDir = join(tempRoot, 'change-center', 'snapshots', 'blobs')
    mkdirSync(blobsDir, { recursive: true })
    const orphan = join(blobsDir, 'deadbeef')
    writeFileSync(orphan, 'orphan')
    const removed = await ctx.snapshots.gcBlobs()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(orphan)).toBe(false)
    // 被引用的 blob 仍存在。
    const marker = readFileSync(join(tempRoot, 'change-center', 'snapshots', 'changes', 'gc-s', 'keep-1', 'blob'), 'utf8')
    expect(existsSync(join(blobsDir, marker.trim()))).toBe(true)
  })
})

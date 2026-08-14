/**
 * Phase-3 service tests: HistoryService event recording.
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { HistoryService } from '../src/history/HistoryService.ts'
import { ChangeService } from '../src/services/ChangeService.ts'

/** Poll until `check` is true (the async persist chains flush to disk). */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('HistoryService', () => {
  let tempRoot: string

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dsh-history-'))
    process.env.DSH_HOME = tempRoot
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('records events from change:created and persists to disk', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(HistoryService)
    await ctx.plugin(ChangeService)

    ctx.changeCenter.record({
      sessionId: 'hist-1', cwd: '/tmp', path: 'a.txt', operation: 'modify',
      before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    })
    // The history listener persists asynchronously; wait for the file.
    const persisted = join(tempRoot, 'change-center', 'history', 'hist-1', 'history.json')
    await waitFor(() => existsSync(persisted))

    const events = ctx.changeHistory.list('hist-1')
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('created')
    expect(events[0]?.actor).toBe('agent')
    expect(events[0]?.changeId).toBe('change-1')
  })

  it('loads persisted history on cold start', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(HistoryService)
    await ctx.plugin(ChangeService)
    ctx.changeCenter.record({
      sessionId: 'cold-1', cwd: '/tmp', path: 'b.txt', operation: 'create',
      before: null, after: 'z\n', source: 'agent', toolName: 'write',
    })
    // Wait for the cold-1 history file before reloading in a new context.
    await waitFor(() => existsSync(join(tempRoot, 'change-center', 'history', 'cold-1', 'history.json')))
    // New context: history service starts empty, load() restores from disk.
    const ctx2 = new Context()
    await ctx2.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx2.plugin(HistoryService)
    await ctx2.changeHistory.load('cold-1')
    const events = ctx2.changeHistory.list('cold-1')
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('created')
  })
})

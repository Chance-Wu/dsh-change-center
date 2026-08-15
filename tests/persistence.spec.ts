/**
 * Phase-A persistence tests: captured changes and change sessions survive a
 * host restart via the JSONL store under $DSH_HOME (through the ctx.fs seam).
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'
import { removeDirSafe } from './helpers/removeDir.ts'

/** Poll until `check` is true (the async persist chains flush to disk). */
async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('change-center store persistence', () => {
  let tempRoot: string

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dsh-store-'))
    process.env.DSH_HOME = tempRoot
  })

  afterAll(async () => {
    delete process.env.DSH_HOME
    await removeDirSafe(tempRoot)
  })

  async function makeCtx(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(ChangeService)
    await ctx.plugin(SessionService)
    return ctx
  }

  it('restores changes and sessions after a host restart', async () => {
    // First host: record one change and transition it; the change.created
    // event opens a fallback session.
    const ctx1 = await makeCtx()
    ctx1.changeCenter.record({
      sessionId: 'agent-1', cwd: '/tmp', kind: 'file', path: 'a.txt',
      operation: 'modify', before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    })
    // 5.x:不再有 approve/reject;apply 一次(无引擎 → failed)以验证状态持久化。
    await ctx1.changeCenter.apply('change-1')
    // Let the fire-and-forget persist chains flush to disk.
    await waitFor(() => existsSync(join(tempRoot, 'change-center', 'store', 'changes.jsonl')))

    // Second host: fresh context, same $DSH_HOME — the store is reloaded.
    const ctx2 = await makeCtx()
    await waitFor(() => ctx2.changeCenter.list().length === 1)
    const changes = ctx2.changeCenter.list()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.path).toBe('a.txt')
    expect(changes[0]?.status).toBe('failed')

    await waitFor(() => ctx2.changeSessions.list().length > 0)
    const sessions = ctx2.changeSessions.list()
    expect(sessions.length).toBeGreaterThan(0)
    expect(sessions[0]?.agentSessionId).toBe('agent-1')
    expect(sessions[0]?.changeIds).toContain('change-1')
    expect(sessions[0]?.statistics.files).toBe(1)
  })

  it('runs purely in memory when no fs service is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(ChangeService)
    await ctx.plugin(SessionService)
    const change = ctx.changeCenter.record({
      sessionId: 'agent-2', cwd: '/tmp', kind: 'file', path: 'b.txt',
      operation: 'create', before: null, after: 'z\n', source: 'agent', toolName: 'write',
    })
    expect(ctx.changeCenter.get(change.id)?.status).toBe('pending')
    expect(ctx.changeSessions.list().length).toBeGreaterThan(0)
  })

  it('reconciles a crash-left active session to completed on restart', async () => {
    const ctx1 = await makeCtx()
    ctx1.changeCenter.record({
      sessionId: 'agent-3', cwd: '/tmp', kind: 'file', path: 'c.txt',
      operation: 'modify', before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    })
    // 模拟崩溃:进程死亡时会话仍是 active(没有 turn/end)。
    const session = ctx1.changeSessions.list()[0]!
    expect(session.status).toBe('active')
    await waitFor(() => existsSync(join(tempRoot, 'change-center', 'store', 'sessions.jsonl')))

    const ctx2 = await makeCtx()
    await waitFor(() => ctx2.changeSessions.list().length > 0)
    expect(ctx2.changeSessions.list()[0]?.status).toBe('completed')
  })
})

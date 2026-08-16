/**
 * Phase-A persistence tests: captured changes and change sessions survive a
 * host restart via the JSONL store under $DSH_HOME (through the ctx.fs seam).
 *
 * 每个测试用独立的 $DSH_HOME:store 文件会跨测试累积,共享目录时 shuffle
 * 顺序会让后写的数据被前一个测试读到(偶发「expected a.txt got c.txt」)。
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'

/** Poll until `check` is true (the async persist chains flush to disk).
 *  超时抛错而非静默返回:全量并发(24 文件并行)负载下磁盘写可能变慢,
 *  把「还没写完」和「真的失败」区分开,避免静默超时后靠断言兜底造成偶发误报。 */
async function waitFor(check: () => boolean, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('change-center store persistence', () => {
  async function makeCtx(root: string): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(ChangeService)
    await ctx.plugin(SessionService)
    return ctx
  }

  /** 每个测试独立 DSH_HOME,互不污染(store 文件跨测试累积会导致顺序相关的偶发失败)。 */
  async function withHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), 'dsh-store-'))
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      return await fn(root)
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('restores changes and sessions after a host restart', async () => {
    await withHome(async root => {
      // First host: record one change and transition it; the change.created
      // event opens a fallback session.
      const ctx1 = await makeCtx(root)
      ctx1.changeCenter.record({
        sessionId: 'agent-1', cwd: '/tmp', kind: 'file', path: 'a.txt',
        operation: 'modify', before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
      })
      // 无 approve/reject:apply 一次(无引擎 → failed)以验证状态持久化。
      await ctx1.changeCenter.apply('change-1')
      // Let the fire-and-forget persist chains flush to disk.
      await waitFor(() => existsSync(join(root, 'change-center', 'store', 'changes.jsonl')))

      // Second host: fresh context, same $DSH_HOME — the store is reloaded.
      const ctx2 = await makeCtx(root)
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
    await withHome(async root => {
      const ctx1 = await makeCtx(root)
      ctx1.changeCenter.record({
        sessionId: 'agent-3', cwd: '/tmp', kind: 'file', path: 'c.txt',
        operation: 'modify', before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
      })
      // 模拟崩溃:进程死亡时会话仍是 active(没有 turn/end)。
      const session = ctx1.changeSessions.list()[0]!
      expect(session.status).toBe('active')
      await waitFor(() => existsSync(join(root, 'change-center', 'store', 'sessions.jsonl')))

      const ctx2 = await makeCtx(root)
      await waitFor(() => ctx2.changeSessions.list().length > 0)
      expect(ctx2.changeSessions.list()[0]?.status).toBe('completed')
    })
  })
})

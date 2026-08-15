/**
 * ChangeService unit tests: in-memory store, diff derivation, and the
 * review state machine transitions.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'

function setup() {
  const ctx = new Context()
  return Promise.all([ctx.plugin(ChangeService), ctx.plugin(SessionService)]).then(() => ctx)
}

/** Poll until the disk-backed store has loaded the given change id. */
async function waitForChange(ctx: Context, id: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (ctx.changeCenter.get(id) === undefined) {
    if (Date.now() - start > timeoutMs) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('ChangeService', () => {
  it('records a change and derives a diff', async () => {
    const ctx = await setup()
    const change = ctx.changeCenter.record({
      sessionId: 'sess-1',
      cwd: '/tmp/ws',
      path: 'src/demo/UserService.java',
      operation: 'modify',
      before: 'return mapper.selectById(id);\n',
      after: 'return mapper.findById(id);\n',
      source: 'agent',
      toolName: 'edit',
    })
    expect(change.status).toBe('pending')
    expect(change.diff).toContain('-return mapper.selectById(id);')
    expect(change.diff).toContain('+return mapper.findById(id);')
    expect(ctx.changeCenter.list()).toHaveLength(1)
  })

  it('treats a write create as create operation', async () => {
    const ctx = await setup()
    const change = ctx.changeCenter.record({
      sessionId: 'sess-1',
      cwd: '/tmp/ws',
      path: 'README.md',
      operation: 'create',
      before: null,
      after: '# Hello\n',
      source: 'agent',
      toolName: 'write',
    })
    expect(change.operation).toBe('create')
    expect(change.before).toBeNull()
  })

  it('enforces state-machine transitions', async () => {
    const ctx = await setup()
    const change = ctx.changeCenter.record({
      sessionId: 'sess-1',
      cwd: '/tmp/ws',
      path: 'a.txt',
      operation: 'modify',
      before: 'x\n',
      after: 'y\n',
      source: 'agent',
      toolName: 'edit',
    })
    // 5.x:无 approve/reject;pending 直接 apply(无引擎 → failed)。
    const result = await ctx.changeCenter.apply(change.id)
    expect(result.kind).toBe('error')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('failed')
    // failed → edit 回 pending(重试/编辑的恢复路径)。
    ctx.changeCenter.edit(change.id, 'y\n')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('pending')
  })

  it('returns a structured error for unknown ids', async () => {
    const ctx = await setup()
    const err = await ctx.changeCenter.apply('nope')
    expect(err).toMatchObject({ kind: 'error' })
    expect((err as { message: string }).message).toContain('unknown change')
  })

  it('emits change.created on record', async () => {
    const ctx = await setup()
    const seen: string[] = []
    ctx.on('change.created', change => { seen.push(change.path) })
    ctx.changeCenter.record({
      sessionId: 'sess-1',
      cwd: '/tmp/ws',
      path: 'b.txt',
      operation: 'modify',
      before: '1\n',
      after: '2\n',
      source: 'agent',
      toolName: 'edit',
    })
    expect(seen).toEqual(['b.txt'])
  })

  it('accept-all-and-apply applies pending and reports apply outcomes', async () => {
    const ctx = await setup()
    ctx.changeCenter.record({
      sessionId: 'batch-a', cwd: '/tmp/ws', path: 'a.txt', operation: 'modify',
      before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    })
    ctx.changeCenter.record({
      sessionId: 'batch-a', cwd: '/tmp/ws', path: 'b.txt', operation: 'create',
      before: null, after: 'hi\n', source: 'agent', toolName: 'write',
    })
    ctx.changeCenter.record({
      sessionId: 'batch-a', cwd: '/tmp/ws', kind: 'command', path: 'npm install', operation: 'execute',
      before: null, after: 'npm install', source: 'agent', toolName: 'bash',
    })
    const result = await ctx.changeCenter.applyAllPending('batch-a')
    // 命令变更直接 applied;文件变更因缺少应用引擎失败。
    expect(result.applied).toHaveLength(1)
    expect(result.failed).toHaveLength(2)
    expect(result.skipped).toHaveLength(0)
    expect(result.superseded).toHaveLength(0)
    expect(ctx.changeCenter.listBySession('batch-a').every(c => c.status !== 'pending')).toBe(true)
  })

  it('accept-all-and-apply skips non-pending changes', async () => {
    const ctx = await setup()
    ctx.changeCenter.record({
      sessionId: 'batch-b', cwd: '/tmp/ws', path: 'a.txt', operation: 'modify',
      before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    })
    // 5.x:无 approve/reject;先 apply 把变更弄成 failed(非 pending → skipped)。
    await ctx.changeCenter.apply('change-1')
    const result = await ctx.changeCenter.applyAllPending('batch-b')
    expect(result.skipped).toEqual(['change-1'])
    expect(result.superseded).toHaveLength(0)
  })

  it('accept-all-and-apply processes one change per path (superseded writes skipped)', async () => {
    const ctx = await setup()
    // 同一文件写两次:先 change-1(旧),后 change-2(新)。
    ctx.changeCenter.record({
      sessionId: 'batch-c', cwd: '/tmp/ws', path: 'a.txt', operation: 'modify',
      before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    })
    await new Promise(resolve => setTimeout(resolve, 2))
    ctx.changeCenter.record({
      sessionId: 'batch-c', cwd: '/tmp/ws', path: 'a.txt', operation: 'modify',
      before: 'y\n', after: 'z\n', source: 'agent', toolName: 'edit',
    })
    const result = await ctx.changeCenter.applyAllPending('batch-c')
    // 最新一条被处理(无引擎 → 失败);旧路径写入归入 superseded。
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.id).toBe('change-2')
    expect(result.superseded).toEqual(['change-1'])
    expect(result.skipped).toHaveLength(0)
  })

  it('accept-all-and-apply holds back deny-policy changes as blocked', async () => {
    const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local')
    const { PolicyService } = await import('../src/policy/PolicyService.ts')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'dsh-policy-gate-'))
    process.env.DSH_HOME = root
    try {
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem, { cwd: root })
      await ctx.plugin(ChangeService)
      await ctx.plugin(SessionService)
      await ctx.plugin(PolicyService)
      // deny-core-delete 命中 src/(security|config)/ 下的删除。
      ctx.changeCenter.record({
        sessionId: 'gate-1', cwd: '/tmp/ws', path: 'src/security/AuthConfig.java', operation: 'delete',
        before: 'x\n', after: null, source: 'agent', toolName: 'edit',
      })
      ctx.changeCenter.record({
        sessionId: 'gate-1', cwd: '/tmp/ws', path: 'src/demo/Util.java', operation: 'modify',
        before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
      })
      const result = await ctx.changeCenter.applyAllPending('gate-1')
      // deny 命中 → blocked,保持 pending;未命中照常处理(无引擎 → 失败)。
      expect(result.blocked).toHaveLength(1)
      expect(result.blocked[0]?.id).toBe('change-1')
      expect(result.blocked[0]?.message).toContain('deny-core-delete')
      expect(ctx.changeCenter.get('change-1')?.status).toBe('pending')
      expect(result.applied).toHaveLength(0)
      expect(result.failed.map(item => item.id)).toEqual(['change-2'])
    } finally {
      delete process.env.DSH_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accept-all-and-apply(force) bypasses the deny gate (Vibe UI 仍然全部应用)', async () => {
    const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local')
    const { PolicyService } = await import('../src/policy/PolicyService.ts')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'dsh-policy-force-'))
    process.env.DSH_HOME = root
    try {
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem, { cwd: root })
      await ctx.plugin(ChangeService)
      await ctx.plugin(SessionService)
      await ctx.plugin(PolicyService)
      ctx.changeCenter.record({
        sessionId: 'gate-2', cwd: '/tmp/ws', path: 'src/security/AuthConfig.java', operation: 'delete',
        before: 'x\n', after: null, source: 'agent', toolName: 'edit',
      })
      // force:deny 门禁被跳过,变更不再 blocked(无应用引擎时仍走 apply → 失败,
      // 但不会停留在 pending+blocked 的死角)。
      const result = await ctx.changeCenter.applyAllPending('gate-2', true)
      expect(result.blocked).toHaveLength(0)
      expect(ctx.changeCenter.get('change-1')?.status).not.toBe('pending')
    } finally {
      delete process.env.DSH_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('SessionService', () => {
  it('groups changes under one session (fallback group without turn events)', async () => {
    const ctx = await setup()
    const a = ctx.changeCenter.record({
      sessionId: 'sess-1', cwd: '/tmp/ws', path: 'a.txt', operation: 'modify',
      before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    })
    const b = ctx.changeCenter.record({
      sessionId: 'sess-1', cwd: '/tmp/ws', path: 'b.txt', operation: 'create',
      before: null, after: 'hi\n', source: 'agent', toolName: 'write',
    })
    const sessions = ctx.changeSessions.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.agentSessionId).toBe('sess-1')
    expect(sessions[0]?.changeIds).toEqual([a.id, b.id])
    expect(ctx.changeSessions.changesOf(sessions[0]!.id)).toHaveLength(2)
  })
})

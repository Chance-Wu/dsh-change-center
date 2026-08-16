/**
 * ChangeService unit tests: in-memory store, diff derivation, and the
 * 5.x state machine (capture 即登记 → applied;写盘经 saveEdit/restore)。
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

describe('ChangeService', () => {
  it('records a change as applied (capture 即登记) and derives a diff', async () => {
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
    // 5.x:agent 工具已写盘 → 捕获即 applied,回滚随时可用。
    expect(change.status).toBe('applied')
    expect(change.diskBaseline).toBe('return mapper.findById(id);\n')
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

  it('saveEdit without engines returns a structured error and keeps applied', async () => {
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
    // 无 ApplyService/SnapshotService:写盘报错,状态保持 applied(不落 failed)。
    const result = await ctx.changeCenter.saveEdit(change.id, 'z\n')
    expect(result.kind).toBe('error')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('applied')
  })

  it('returns a structured error for unknown ids', async () => {
    const ctx = await setup()
    const err = await ctx.changeCenter.rollback('nope')
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

  it('同一会话同路径多次写入合并为一条记录(只 diff 最新),保持 applied', async () => {
    const ctx = await setup()
    // 同一文件写两次:第二次合并进第一条,不再产生第二条记录。
    const first = ctx.changeCenter.record({
      sessionId: 'batch-c', cwd: '/tmp/ws', path: 'a.txt', operation: 'modify',
      before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    })
    await new Promise(resolve => setTimeout(resolve, 2))
    const merged = ctx.changeCenter.record({
      sessionId: 'batch-c', cwd: '/tmp/ws', path: 'a.txt', operation: 'modify',
      before: 'y\n', after: 'z\n', source: 'agent', toolName: 'edit',
    })
    // 同一条记录:保留最初 before,after/diff 为最新(只 diff 最新的)。
    expect(merged.id).toBe(first.id)
    const change = ctx.changeCenter.get(first.id)
    expect(change?.before).toBe('x\n')
    expect(change?.after).toBe('z\n')
    expect(change?.diff).toContain('-x')
    expect(change?.diff).toContain('+z')
    expect(change?.status).toBe('applied')
    expect(change?.diskBaseline).toBe('z\n')
    expect(ctx.changeCenter.listBySession('batch-c')).toHaveLength(1)
  })

  it('合并后块级状态作废,磁盘基线取最新', async () => {
    const ctx = await setup()
    const id = ctx.changeCenter.record({
      sessionId: 'm-1', cwd: '/tmp/ws', path: 'f.ts', operation: 'modify',
      before: 'a\n', after: 'b\n', source: 'agent', toolName: 'edit',
    }).id
    // 模拟做过块级操作。
    const confirmed = ctx.changeCenter.get(id)!
    confirmed.hunkApplied = [true]
    confirmed.hunkEdits = [['b']]
    // 再次写入同一文件 → 合并:块级状态清空、基线取最新。
    ctx.changeCenter.record({
      sessionId: 'm-1', cwd: '/tmp/ws', path: 'f.ts', operation: 'modify',
      before: 'b\n', after: 'c\n', source: 'agent', toolName: 'edit',
    })
    const merged = ctx.changeCenter.get(id)!
    expect(merged.status).toBe('applied')
    expect(merged.hunkApplied).toBeUndefined()
    expect(merged.hunkEdits).toBeUndefined()
    expect(merged.diskBaseline).toBe('c\n')
    expect(merged.after).toBe('c\n')
    // 不同会话的同路径写入不合并。
    const other = ctx.changeCenter.record({
      sessionId: 'm-2', cwd: '/tmp/ws', path: 'f.ts', operation: 'modify',
      before: 'c\n', after: 'd\n', source: 'agent', toolName: 'edit',
    })
    expect(other.id).not.toBe(id)
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

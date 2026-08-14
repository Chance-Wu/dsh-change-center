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
    ctx.changeCenter.approve(change.id)
    expect(ctx.changeCenter.get(change.id)?.status).toBe('approved')
    // approve is a review transition; apply (real write-back) requires the
    // apply/snapshot engines and reports an error when they are absent.
    const result = await ctx.changeCenter.apply(change.id)
    expect(result.kind).toBe('error')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('failed')
    // failed can be re-pended, then rejected
    ctx.changeCenter.edit(change.id, 'y\n')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('pending')
    ctx.changeCenter.reject(change.id)
    expect(ctx.changeCenter.get(change.id)?.status).toBe('rejected')
    // applied cannot be rejected
    expect(() => ctx.changeCenter.reject(change.id)).toThrow(/cannot transition/)
  })

  it('rejects unknown ids', async () => {
    const ctx = await setup()
    expect(() => ctx.changeCenter.approve('nope')).toThrow(/unknown change/)
  })

  it('emits change:created on record', async () => {
    const ctx = await setup()
    const seen: string[] = []
    ctx.on('change:created', change => { seen.push(change.path) })
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

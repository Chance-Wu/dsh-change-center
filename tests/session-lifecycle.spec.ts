/**
 * Session lifecycle unit tests: turn/start opens a session, turn/end
 * completes it, captured changes attach and accumulate statistics.
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'
import { ApplyService } from '../src/services/ApplyService.ts'
import { SnapshotService } from '../src/services/SnapshotService.ts'
import { removeDirSafe } from './helpers/removeDir.ts'

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-change-center-session-'))
})

afterAll(async () => {
  await removeDirSafe(tempDir)
})

async function setup(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ChangeService)
  await ctx.plugin(SessionService)
  await ctx.plugin(ApplyService)
  await ctx.plugin(SnapshotService)
  // An attached session: session/event fires on every append.
  const session = ctx.sessions.create(SessionId('agent-1'), {
    meta: { cwd: tempDir, createdAt: Date.now() },
  })
  return { ctx, session }
}

describe('SessionService turn lifecycle', () => {
  it('opens a session on turn/start and completes it on turn/end', async () => {
    const { ctx, session } = await setup()

    session.append('turn/start', { turn: 1 })
    let sessions = ctx.changeSessions.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.status).toBe('active')
    expect(sessions[0]?.agentSessionId).toBe('agent-1')
    expect(sessions[0]?.workspace).toBe(tempDir)

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    sessions = ctx.changeSessions.list()
    expect(sessions[0]?.status).toBe('completed')
  })

  it('opens a new session per turn', async () => {
    const { ctx, session } = await setup()
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    expect(ctx.changeSessions.list()).toHaveLength(2)
  })

  it('attaches captured changes and accumulates statistics', async () => {
    const { ctx, session } = await setup()
    session.append('turn/start', { turn: 1 })

    ctx.changeCenter.record({
      sessionId: 'agent-1',
      cwd: tempDir,
      path: 'src/a.txt',
      operation: 'modify',
      before: 'a\nb\n',
      after: 'a\nb\nc\n',
      source: 'agent',
      toolName: 'edit',
    })
    ctx.changeCenter.record({
      sessionId: 'agent-1',
      cwd: tempDir,
      path: 'src/b.txt',
      operation: 'create',
      before: null,
      after: 'x\ny\n',
      source: 'agent',
      toolName: 'write',
    })

    const changeSession = ctx.changeSessions.list()[0]!
    expect(changeSession.changeIds).toHaveLength(2)
    // 1 insertion + 2 additions = 3; 0 deletions.
    expect(changeSession.statistics).toEqual({ files: 2, additions: 3, deletions: 0 })
  })

  it('uses the agent session title for the change-session name (标题优先)', async () => {
    const { ctx, session } = await setup()
    session.append('turn/start', { turn: 1 })
    session.append('session/title', { title: '优化任务胶囊标题' })
    ctx.changeCenter.record({
      sessionId: 'agent-1',
      cwd: tempDir,
      path: 'src/a.txt',
      operation: 'modify',
      before: 'a\n',
      after: 'b\n',
      source: 'agent',
      toolName: 'edit',
    })
    const cs = ctx.changeSessions.list()[0]!
    // 标题存在时 name 就是标题,变更摘要不再覆盖。
    expect(cs.title).toBe('优化任务胶囊标题')
    expect(cs.name).toBe('优化任务胶囊标题')
  })

  it('names the session with turn prefix + change summary (管理友好)', async () => {
    const { ctx, session } = await setup()
    session.append('turn/start', { turn: 1 })
    ctx.changeCenter.record({
      sessionId: 'agent-1',
      cwd: tempDir,
      path: 'src/auth/token.ts',
      operation: 'create',
      before: null,
      after: 'x\n',
      source: 'agent',
      toolName: 'write',
    })
    ctx.changeCenter.record({
      sessionId: 'agent-1',
      cwd: tempDir,
      path: 'src/auth/role.ts',
      operation: 'modify',
      before: 'a\n',
      after: 'b\n',
      source: 'agent',
      toolName: 'edit',
    })
    const changeSession = ctx.changeSessions.list()[0]!
    expect(changeSession.name).toBe('第 1 轮 · 修改 src/auth 下 2 个文件')
  })

  it('derives a natural-language summary from paths and operations (S-8)', async () => {
    const { ctx, session } = await setup()
    session.append('turn/start', { turn: 1 })

    ctx.changeCenter.record({
      sessionId: 'agent-1', cwd: tempDir, path: `${tempDir}/src/auth/token.ts`,
      operation: 'modify', before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    })
    ctx.changeCenter.record({
      sessionId: 'agent-1', cwd: tempDir, path: `${tempDir}/src/auth/service.ts`,
      operation: 'create', before: null, after: 'z\n', source: 'agent', toolName: 'write',
    })

    const changeSession = ctx.changeSessions.list()[0]!
    expect(changeSession.summary).toBe('修改 src/auth 下 2 个文件')
  })

  it('falls back to a group when a change arrives without turn/start', async () => {
    const ctx = new Context()
    await ctx.plugin(ChangeService)
    await ctx.plugin(SessionService)
    ctx.changeCenter.record({
      sessionId: 'orphan-1',
      cwd: tempDir,
      path: 'x.txt',
      operation: 'modify',
      before: '1\n',
      after: '2\n',
      source: 'agent',
      toolName: 'edit',
    })
    expect(ctx.changeSessions.list()).toHaveLength(1)
    expect(ctx.changeSessions.changesOf(ctx.changeSessions.list()[0]!.id)).toHaveLength(1)
  })
})

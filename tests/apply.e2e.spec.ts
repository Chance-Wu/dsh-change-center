/**
 * Phase-2 integration tests: real write tool → capture 即登记(applied + 快照)
 * → 编辑保存(写盘)/回滚(快照恢复)/恢复,以及外部修改冲突守卫。Runs against
 * a real ToolRuntime + local filesystem in a temp directory.
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyCapture } from '../src/capture/ToolCapture.ts'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'
import { ApplyService } from '../src/services/ApplyService.ts'
import { SnapshotService } from '../src/services/SnapshotService.ts'
import { removeDirSafe } from './helpers/removeDir.ts'
import { waitForSnapshot } from './helpers/waitSnapshot.ts'

const testSignal = new AbortController().signal

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-change-center-'))
  // Persistence (snapshots, history, policies) lives under $DSH_HOME; point
  // it at the writable temp dir so the sandbox allows the writes.
  process.env.DSH_HOME = join(tempDir, 'dsh-home')
})

afterAll(async () => {
  delete process.env.DSH_HOME
  await removeDirSafe(tempDir)
})

/** A parent Agent backed by a real Session rooted at tempDir. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now(),
    cwd: tempDir,
  })
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: tempDir })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ChangeService)
  await ctx.plugin(SessionService)
  await ctx.plugin(ApplyService)
  await ctx.plugin(SnapshotService)
  applyCapture(ctx)
  return ctx
}

let callCounter = 0

function executeWrite(ctx: Context, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: `call-${++callCounter}`,
    name: 'write',
    arguments: args,
    agent,
  })
}

describe('Capture → 写盘/回滚 e2e', () => {
  it('capture 即登记:write 工具写盘后直接 applied,磁盘=after', async () => {
    const ctx = await setup()
    const agent = agentWithSession('apply-1')
    const target = join(tempDir, 'Service.java')
    writeFileSync(target, 'old service\n')

    await executeWrite(ctx, { file_path: target, content: 'new service\n' }, agent)
    const change = ctx.changeCenter.list()[0]!
    expect(change.status).toBe('applied')
    expect(change.diskBaseline).toBe('new service\n')
    expect(readFileSync(target, 'utf8')).toBe('new service\n')
  })

  it('rolls an applied change back to its pre-apply content (无需先「应用」)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('rollback-1')
    const target = join(tempDir, 'Rollback.java')
    writeFileSync(target, 'original\n')

    await executeWrite(ctx, { file_path: target, content: 'changed\n' }, agent)
    const change = ctx.changeCenter.list()[0]!
    await waitForSnapshot(change.sessionId, change.id)
    expect(readFileSync(target, 'utf8')).toBe('changed\n')

    const result = await ctx.changeCenter.rollback(change.id)
    expect(result.kind).toBe('rolled-back')
    expect(readFileSync(target, 'utf8')).toBe('original\n')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('rolled_back')
  })

  it('detects an external modification before save and refuses to overwrite', async () => {
    const ctx = await setup()
    const agent = agentWithSession('conflict-1')
    const target = join(tempDir, 'Conflict.java')
    writeFileSync(target, 'before\n')

    await executeWrite(ctx, { file_path: target, content: 'after\n' }, agent)
    const change = ctx.changeCenter.list()[0]!

    // External edit after capture.
    writeFileSync(target, 'externally edited\n')
    const result = await ctx.changeCenter.saveEdit(change.id, 'my edit\n')
    expect(result.kind).toBe('conflict')
    // The external content is preserved; status stays applied (not failed).
    expect(readFileSync(target, 'utf8')).toBe('externally edited\n')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('applied')
  })

  it('force-save bypasses the external-mutation guard', async () => {
    const ctx = await setup()
    const agent = agentWithSession('force-1')
    const target = join(tempDir, 'Force.java')
    writeFileSync(target, 'before\n')

    await executeWrite(ctx, { file_path: target, content: 'after\n' }, agent)
    const change = ctx.changeCenter.list()[0]!

    writeFileSync(target, 'externally edited\n')
    const result = await ctx.changeCenter.saveEdit(change.id, 'my edit\n', true)
    expect(result.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('my edit\n')
  })

  it('rolls back a created file by deleting it', async () => {
    const ctx = await setup()
    const agent = agentWithSession('rollback-create-1')
    const target = join(tempDir, 'Created.java')

    await executeWrite(ctx, { file_path: target, content: 'public class Created {}\n' }, agent)
    const change = ctx.changeCenter.list()[0]!
    await waitForSnapshot(change.sessionId, change.id)
    expect(readFileSync(target, 'utf8')).toBe('public class Created {}\n')

    const result = await ctx.changeCenter.rollback(change.id)
    expect(result.kind).toBe('rolled-back')
    expect(() => readFileSync(target, 'utf8')).toThrow(/ENOENT/)
    expect(ctx.changeCenter.get(change.id)?.status).toBe('rolled_back')
  })

  it('rollback-all restores every applied change to its pre-apply content', async () => {
    const ctx = await setup()
    const agent = agentWithSession('rollback-all-1')
    const a = join(tempDir, 'R1.java')
    const b = join(tempDir, 'R2.java')
    writeFileSync(a, 'old a\n')
    writeFileSync(b, 'old b\n')

    await executeWrite(ctx, { file_path: a, content: 'new a\n' }, agent)
    await executeWrite(ctx, { file_path: b, content: 'new b\n' }, agent)
    const ca = ctx.changeCenter.list()[0]!
    const cb = ctx.changeCenter.list()[1]!
    await waitForSnapshot(ca.sessionId, ca.id)
    await waitForSnapshot(cb.sessionId, cb.id)
    expect(ctx.changeCenter.listBySession('rollback-all-1').every(c => c.status === 'applied')).toBe(true)

    const result = await ctx.changeCenter.rollbackAll('rollback-all-1')
    expect(result.rolledBack).toHaveLength(2)
    expect(result.missing).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
    expect(readFileSync(a, 'utf8')).toBe('old a\n')
    expect(readFileSync(b, 'utf8')).toBe('old b\n')
    expect(ctx.changeCenter.listBySession('rollback-all-1').every(c => c.status === 'rolled_back')).toBe(true)
  })

  it('rollback-all 用 agent session id 而非 change-session id(route mapping)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('bulk-route-1')
    const target = join(tempDir, 'BulkRoute.java')
    writeFileSync(target, 'original\n')

    await executeWrite(ctx, { file_path: target, content: 'bulk applied\n' }, agent)
    const change = ctx.changeCenter.list()[0]!
    await waitForSnapshot(change.sessionId, change.id)
    // A command record rides the same session: capture 即 applied(标记),
    // 无快照 —— rollback-all 跳过它,不产生 missing 噪音。
    ctx.changeCenter.record({
      sessionId: 'bulk-route-1',
      cwd: tempDir,
      kind: 'command',
      path: 'ls -la',
      operation: 'execute',
      before: null,
      after: 'ls -la',
      source: 'agent',
      toolName: 'bash',
    })
    const commandChange = ctx.changeCenter.listBySession('bulk-route-1').find(c => c.kind === 'command')!

    // SessionService opens a change-session per captured change; the HTTP
    // route receives THAT id. The change store is keyed by the AGENT session
    // id (change.sessionId), so the route maps changeSession.id → agentSessionId.
    const changeSession = ctx.changeSessions.list()[0]!
    expect(changeSession.agentSessionId).toBe('bulk-route-1')
    expect(changeSession.id).not.toBe('bulk-route-1')

    const wrongKey = await ctx.changeCenter.rollbackAll(changeSession.id)
    expect(wrongKey.rolledBack).toHaveLength(0)

    // 用 agent session id:文件回滚,命令标记跳过。
    const rolled = await ctx.changeCenter.rollbackAll(changeSession.agentSessionId)
    expect(rolled.rolledBack).toEqual([change.id])
    expect(rolled.missing).toHaveLength(0)
    expect(rolled.failed).toHaveLength(0)
    expect(readFileSync(target, 'utf8')).toBe('original\n')
    expect(ctx.changeCenter.get(commandChange.id)?.status).toBe('applied')
  })
})

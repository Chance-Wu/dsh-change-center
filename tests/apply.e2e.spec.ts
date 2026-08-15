/**
 * Phase-2 integration tests: real write tool → capture → apply (atomic
 * write-back) → rollback (snapshot restore), plus the external-mutation
 * conflict guard. Runs against a real ToolRuntime + local filesystem in a
 * temp directory.
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

describe('Apply Engine e2e', () => {
  it('applies an approved change back to the workspace', async () => {
    const ctx = await setup()
    const agent = agentWithSession('apply-1')
    const target = join(tempDir, 'Service.java')
    writeFileSync(target, 'old service\n')

    await executeWrite(ctx, { file_path: target, content: 'new service\n' }, agent)
    const change = ctx.changeCenter.list()[0]!
    const result = await ctx.changeCenter.apply(change.id)
    expect(result.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('new service\n')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('applied')
  })

  it('rolls an applied change back to its pre-apply content', async () => {
    const ctx = await setup()
    const agent = agentWithSession('rollback-1')
    const target = join(tempDir, 'Rollback.java')
    writeFileSync(target, 'original\n')

    await executeWrite(ctx, { file_path: target, content: 'changed\n' }, agent)
    const change = ctx.changeCenter.list()[0]!
    await ctx.changeCenter.apply(change.id)
    expect(readFileSync(target, 'utf8')).toBe('changed\n')

    const result = await ctx.changeCenter.rollback(change.id)
    expect(result.kind).toBe('rolled-back')
    expect(readFileSync(target, 'utf8')).toBe('original\n')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('rolled_back')
  })

  it('detects an external modification before apply and refuses to overwrite', async () => {
    const ctx = await setup()
    const agent = agentWithSession('conflict-1')
    const target = join(tempDir, 'Conflict.java')
    writeFileSync(target, 'before\n')

    await executeWrite(ctx, { file_path: target, content: 'after\n' }, agent)
    const change = ctx.changeCenter.list()[0]!

    // External edit after capture, before apply.
    writeFileSync(target, 'externally edited\n')
    const result = await ctx.changeCenter.apply(change.id)
    expect(result.kind).toBe('conflict')
    // The external content is preserved.
    expect(readFileSync(target, 'utf8')).toBe('externally edited\n')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('failed')
  })

  it('force-apply bypasses the external-mutation guard', async () => {
    const ctx = await setup()
    const agent = agentWithSession('force-1')
    const target = join(tempDir, 'Force.java')
    writeFileSync(target, 'before\n')

    await executeWrite(ctx, { file_path: target, content: 'after\n' }, agent)
    const change = ctx.changeCenter.list()[0]!

    writeFileSync(target, 'externally edited\n')
    const result = await ctx.changeCenter.apply(change.id, true)
    expect(result.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('after\n')
  })

  it('rolls back a created file by deleting it', async () => {
    const ctx = await setup()
    const agent = agentWithSession('rollback-create-1')
    const target = join(tempDir, 'Created.java')

    await executeWrite(ctx, { file_path: target, content: 'public class Created {}\n' }, agent)
    const change = ctx.changeCenter.list()[0]!
    await ctx.changeCenter.apply(change.id)
    expect(readFileSync(target, 'utf8')).toBe('public class Created {}\n')

    const result = await ctx.changeCenter.rollback(change.id)
    expect(result.kind).toBe('rolled-back')
    expect(() => readFileSync(target, 'utf8')).toThrow(/ENOENT/)
    expect(ctx.changeCenter.get(change.id)?.status).toBe('rolled_back')
  })

  it('session-level accept-all approves every pending change', async () => {
    const ctx = await setup()
    const agent = agentWithSession('batch-1')
    await executeWrite(ctx, { file_path: join(tempDir, 'a.txt'), content: 'A\n' }, agent)
    await executeWrite(ctx, { file_path: join(tempDir, 'b.txt'), content: 'B\n' }, agent)
    expect(ctx.changeCenter.listBySession('batch-1').every(c => c.status === 'pending')).toBe(true)
    const updated = ctx.changeCenter.approveAll('batch-1')
    expect(updated).toHaveLength(2)
    expect(ctx.changeCenter.listBySession('batch-1').every(c => c.status === 'approved')).toBe(true)
  })

  it('refuses to edit an applied change (roll back first)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('edit-applied-1')
    const target = join(tempDir, 'EditApplied.java')
    writeFileSync(target, 'before\n')

    await executeWrite(ctx, { file_path: target, content: 'after\n' }, agent)
    const change = ctx.changeCenter.list()[0]!
    const result = await ctx.changeCenter.apply(change.id)
    expect(result.kind).toBe('applied')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('applied')
    // Editing an applied change would desync the record from disk.
    expect(() => ctx.changeCenter.edit(change.id, 'edited\n')).toThrow(/roll back first/)
  })

  it('accept-all-and-apply approves and applies every pending change', async () => {
    const ctx = await setup()
    const agent = agentWithSession('accept-apply-1')
    const a = join(tempDir, 'A.java')
    const b = join(tempDir, 'B.java')
    writeFileSync(a, 'old a\n')
    writeFileSync(b, 'old b\n')

    await executeWrite(ctx, { file_path: a, content: 'new a\n' }, agent)
    await executeWrite(ctx, { file_path: b, content: 'new b\n' }, agent)

    const result = await ctx.changeCenter.acceptAllAndApply('accept-apply-1')
    expect(result.approved).toHaveLength(2)
    expect(result.applied).toHaveLength(2)
    expect(result.failed).toHaveLength(0)
    expect(readFileSync(a, 'utf8')).toBe('new a\n')
    expect(readFileSync(b, 'utf8')).toBe('new b\n')
    expect(ctx.changeCenter.listBySession('accept-apply-1').every(c => c.status === 'applied')).toBe(true)
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
    const applied = await ctx.changeCenter.acceptAllAndApply('rollback-all-1')
    expect(applied.applied).toHaveLength(2)

    const result = await ctx.changeCenter.rollbackAll('rollback-all-1')
    expect(result.rolledBack).toHaveLength(2)
    expect(result.missing).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
    expect(readFileSync(a, 'utf8')).toBe('old a\n')
    expect(readFileSync(b, 'utf8')).toBe('old b\n')
    expect(ctx.changeCenter.listBySession('rollback-all-1').every(c => c.status === 'rolled_back')).toBe(true)
  })

  it('bulk ops must use the agent session id, not the change-session id (route mapping)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('bulk-route-1')
    const target = join(tempDir, 'BulkRoute.java')
    writeFileSync(target, 'original\n')

    await executeWrite(ctx, { file_path: target, content: 'bulk applied\n' }, agent)
    const change = ctx.changeCenter.list()[0]!
    // A command record rides the same session: it applies as a marker and
    // must not pollute rollback-all with missing-snapshot noise.
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
    const commandChange = ctx.changeCenter.list()[1]!

    // SessionService opens a change-session per captured change; the HTTP
    // route receives THAT id. The change store is keyed by the AGENT session
    // id (change.sessionId), so passing the change-session id directly — the
    // pre-fix route behavior — silently matches nothing.
    const changeSession = ctx.changeSessions.list()[0]!
    expect(changeSession.agentSessionId).toBe('bulk-route-1')
    expect(changeSession.id).not.toBe('bulk-route-1')

    const wrongKey = await ctx.changeCenter.acceptAllAndApply(changeSession.id)
    expect(wrongKey.applied).toHaveLength(0)
    expect(ctx.changeCenter.get(change.id)?.status).toBe('pending')

    // The route maps changeSession.id → changeSession.agentSessionId first.
    const result = await ctx.changeCenter.acceptAllAndApply(changeSession.agentSessionId)
    expect(result.applied).toContain(change.id)
    expect(result.applied).toContain(commandChange.id)
    expect(ctx.changeCenter.get(change.id)?.status).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('bulk applied\n')

    // Rollback-all restores the file; the command marker is skipped (no
    // snapshot exists for it) instead of surfacing as a missing snapshot.
    const rolled = await ctx.changeCenter.rollbackAll(changeSession.agentSessionId)
    expect(rolled.rolledBack).toEqual([change.id])
    expect(rolled.missing).toHaveLength(0)
    expect(rolled.failed).toHaveLength(0)
    expect(readFileSync(target, 'utf8')).toBe('original\n')
  })
})

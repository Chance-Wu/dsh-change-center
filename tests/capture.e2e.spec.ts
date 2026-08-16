/**
 * End-to-end capture test: a real `write` tool executes through the real
 * `ToolRuntime` pipeline; the plugin's `tools/result` listener captures the
 * change into the in-memory store. Mirrors the tool-todo test pattern
 * (real registry + fake agent carrying a real Session).
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyCapture } from '../src/capture/ToolCapture.ts'
import { ChangeService } from '../src/services/ChangeService.ts'
import { removeDirSafe } from './helpers/removeDir.ts'

const testSignal = new AbortController().signal

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-change-center-'))
  // Persistence lives under $DSH_HOME; point it at the writable temp dir so
  // the test never sees the live host's captured changes (command captures).
  process.env.DSH_HOME = join(tempDir, 'dsh-home')
})

afterAll(async () => {
  delete process.env.DSH_HOME
  await removeDirSafe(tempDir)
})

/** A parent Agent backed by a real Session (the capture reads agent.session.id). */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: tempDir })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ChangeService)
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

describe('ToolCapture e2e (real write tool)', () => {
  it('captures a file create with full content and a diff', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    const target = join(tempDir, 'UserService.java')

    await executeWrite(ctx, {
      file_path: target,
      content: 'public class UserService {}\n',
    }, agent)

    const changes = ctx.changeCenter.list()
    expect(changes).toHaveLength(1)
    const change = changes[0]!
    expect(change.sessionId).toBe('parent-1')
    expect(change.path).toContain('UserService.java')
    expect(change.operation).toBe('create')
    expect(change.before).toBeNull()
    expect(change.after).toContain('public class UserService')
    expect(change.status).toBe('applied')
  })

  it('captures an overwrite as modify with before/after diff', async () => {
    const ctx = await setup()
    const agent = agentWithSession('parent-2')
    const target = join(tempDir, 'Service.java')
    writeFileSync(target, 'old service\n')

    await executeWrite(ctx, {
      file_path: target,
      content: 'new service\n',
    }, agent)

    const changes = ctx.changeCenter.listBySession('parent-2')
    expect(changes).toHaveLength(1)
    const change = changes[0]!
    expect(change.operation).toBe('modify')
    expect(change.before).toBe('old service\n')
    expect(change.after).toBe('new service\n')
    expect(change.diff).toContain('-old service')
    expect(change.diff).toContain('+new service')
  })
})

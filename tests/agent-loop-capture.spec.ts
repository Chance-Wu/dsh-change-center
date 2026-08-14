/**
 * Real-agent-loop capture regression test: a scripted mock model drives the
 * REAL write tool through the agent loop (the same path a live model takes in
 * web/headless), verifying the plugin captures the change. This reproduces
 * the phase-4 report that real agent sessions produce no captures.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { applyCapture } from '../src/capture/ToolCapture.ts'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'
import { textResponse, toolCallResponse, MockAdapter } from './helpers/mock-adapter.ts'

async function harness(adapter: MockAdapter, cwd: string): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {})
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalFileSystem, { cwd })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ChangeService)
  await ctx.plugin(SessionService)
  applyCapture(ctx)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('capture through the real agent loop', () => {
  it('captures a write tool call as a change', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-loop-'))
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'write', {
        file_path: join(cwd, 'A.java'),
        content: 'public class A {}\n',
      }, 'Creating A.java.'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, cwd)
    const agent = ctx.agentLoop.create(SessionId('loop-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'create A.java' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    const changes = ctx.changeCenter.list()
    console.log('captured changes:', changes.length)
    expect(changes.length).toBeGreaterThan(0)
    rmSync(cwd, { recursive: true, force: true })
  })
})

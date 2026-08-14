/**
 * Phase-4 integration tests: real bash tool → command-change capture, and
 * AI fix through a fake llm adapter → new pending change.
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
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyCapture } from '../src/capture/ToolCapture.ts'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'
import { AIReviewService } from '../src/review/AIReviewService.ts'
import { AIFixService } from '../src/fix/AIFixService.ts'
import { ReviewFixLoopService } from '../src/loop/ReviewFixLoopService.ts'

const testSignal = new AbortController().signal

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-phase4-'))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
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

let callCounter = 0

function execute(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: `call-${++callCounter}`,
    name,
    arguments: args,
    agent,
  })
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(BashLocal)
  await ctx.plugin(ShellEnv)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: tempDir })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ToolBash)
  await ctx.plugin(ChangeService)
  await ctx.plugin(SessionService)
  applyCapture(ctx)
  return ctx
}

describe('CommandChange capture (real bash tool)', () => {
  it('captures a bash command as a command change', async () => {
    const ctx = await setup()
    const agent = agentWithSession('cmd-1')
    await execute(ctx, 'bash', { command: 'npm install lodash', description: 'install lodash' }, agent)

    const changes = ctx.changeCenter.listBySession('cmd-1')
    expect(changes.length).toBeGreaterThan(0)
    const commandChange = changes.find(change => change.kind === 'command')
    expect(commandChange).toBeDefined()
    expect(commandChange?.path).toContain('npm install lodash')
    expect(commandChange?.after).toContain('npm install lodash')
    expect(commandChange?.operation).toBe('execute')
  })

  it('marks a command change applied without re-running it', async () => {
    const ctx = await setup()
    const agent = agentWithSession('cmd-2')
    await execute(ctx, 'bash', { command: 'git checkout feature', description: 'switch branch' }, agent)
    const commandChange = ctx.changeCenter.listBySession('cmd-2').find(c => c.kind === 'command')!
    const result = await ctx.changeCenter.apply(commandChange.id)
    expect(result.kind).toBe('applied')
    expect(ctx.changeCenter.get(commandChange.id)?.status).toBe('applied')
  })
})

describe('AIFixService with fake llm adapter', () => {
  it('records a fix as a new pending change via edit()', async () => {
    const ctx = new Context()
    await ctx.plugin(ChangeService)
    await ctx.plugin(AIReviewService)
    // Provide a fake llm stream and default model BEFORE mounting aiFix, so
    // its optional ctx.get('llm') resolves to the stub.
    ctx.provide('llm', {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '```java\npublic class Fixed {}\n```' } as never
        yield { type: 'finish', reason: { kind: 'stop' } } as never
      },
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'fake', model: 'fake' }),
    })
    await ctx.plugin(AIFixService)

    const change = ctx.changeCenter.record({
      sessionId: 'fix-1', cwd: tempDir, kind: 'file',
      path: 'src/Bug.java', operation: 'modify',
      before: 'public class Bug {}\n', after: 'public class Bug {}\n',
      source: 'agent', toolName: 'edit',
    })

    const finding = {
      id: 'f1', severity: 'error' as const, filePath: 'src/Bug.java',
      title: 'Unsafe', description: 'unsafe code', suggestion: 'fix it',
    }
    const result = await ctx.aiFix.fix('review-1', finding, change, ctx.changeCenter)
    expect(result.fixRequestId).toBeDefined()
    expect(result.changeIds).toContain(change.id)
    // The change's after was replaced and reset to pending.
    const updated = ctx.changeCenter.get(change.id)!
    expect(updated.after).toContain('public class Fixed {}')
    expect(updated.status).toBe('pending')
    // Nothing was written to disk.
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(tempDir, 'src/Bug.java'))).toBe(false)
  })
})

describe('ReviewFixLoopService', () => {
  it('emits limit-reached when findings persist beyond max iterations', async () => {
    const ctx = new Context()
    await ctx.plugin(ChangeService)
    await ctx.plugin(SessionService)
    await ctx.plugin(AIReviewService)
    ctx.provide('llm', {
      stream: async function* () {
        const text = JSON.stringify({
          risk: 'high', score: 40, summary: 'still broken',
          findings: [{ severity: 'error', file: 'src/Bug.java', title: 'Unsafe', description: 'x' }],
        })
        yield { type: 'text-delta', index: 0, text } as never
        yield { type: 'finish', reason: { kind: 'stop' } } as never
      },
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'fake', model: 'fake' }),
    })
    await ctx.plugin(AIFixService)
    await ctx.plugin(ReviewFixLoopService)

    const seen: string[] = []
    ctx.on('loop:limit-reached', () => { seen.push('limit') })

    ctx.changeCenter.record({
      sessionId: 'loop-1', cwd: tempDir, kind: 'file',
      path: 'src/Bug.java', operation: 'modify',
      before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    })
    const result = await ctx.fixLoop.run('loop-1', tempDir, 1)
    expect(result.stopped).toBe('limit-reached')
    expect(seen).toEqual(['limit'])
  })
})

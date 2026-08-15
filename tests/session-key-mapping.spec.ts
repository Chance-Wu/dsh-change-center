/**
 * Regression tests for the change-session id → agent session id mapping in
 * risk analysis and the review-fix loop (P0-1). The change store
 * (`ChangeService.listBySession`) is keyed by the AGENT session id
 * (`change.sessionId` from tool capture), while the HTTP route hands these
 * services the change-session id (`session-N`) — a mismatch silently emptied
 * the change list: risk always came back low and the fix loop never found a
 * change to fix. Both services must resolve the mapping themselves.
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'
import { RiskService } from '../src/risk/RiskService.ts'
import { AIReviewService } from '../src/review/AIReviewService.ts'
import { AIFixService } from '../src/fix/AIFixService.ts'
import { ReviewFixLoopService } from '../src/loop/ReviewFixLoopService.ts'
import { removeDirSafe } from './helpers/removeDir.ts'

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-keymap-'))
  process.env.DSH_HOME = join(tempDir, 'dsh-home')
})

afterAll(async () => {
  delete process.env.DSH_HOME
  await removeDirSafe(tempDir)
})

/** Record one file change and return both the change and its change-session. */
function recordWithSession(ctx: Context, sessionId: string, path: string, operation: 'create' | 'modify' | 'delete') {
  const change = ctx.changeCenter.record({
    sessionId, cwd: tempDir, kind: 'file',
    path, operation,
    before: operation === 'create' ? null : 'old\n',
    after: operation === 'delete' ? null : 'new\n',
    source: 'agent', toolName: 'edit',
  })
  // SessionService opens a change-session per captured change; its id
  // (`session-N`) differs from the agent session id the store is keyed by.
  const changeSession = ctx.changeSessions.list()[0]!
  expect(changeSession.agentSessionId).toBe(sessionId)
  expect(changeSession.id).not.toBe(sessionId)
  return { change, changeSession }
}

describe('RiskService.analyze key mapping', () => {
  it('sees the session changes when called with the change-session id', async () => {
    const ctx = new Context()
    await ctx.plugin(ChangeService)
    await ctx.plugin(SessionService)
    await ctx.plugin(RiskService)

    const { changeSession } = recordWithSession(ctx, 'risk-key-1', '/srv/db/app.sql', 'modify')

    const risk = ctx.risk.analyze(changeSession.id, ctx.changeCenter)
    // A `.sql` path is a HIGH sensitive-path rule — with the mapping broken
    // the change list is empty and the level would stay low.
    expect(risk.level).toBe('high')
    expect(risk.reasons.some(reason => reason.rule === 'sensitive-path')).toBe(true)
  })

  it('still works for headless callers passing the agent key directly', async () => {
    const ctx = new Context()
    await ctx.plugin(ChangeService)
    await ctx.plugin(SessionService)
    await ctx.plugin(RiskService)

    recordWithSession(ctx, 'risk-key-2', '/etc/application.yml', 'modify')

    const risk = ctx.risk.analyze('risk-key-2', ctx.changeCenter)
    expect(risk.level).toBe('medium')
  })
})

describe('ReviewFixLoopService key mapping', () => {
  it('fixes a finding when run with the change-session id', async () => {
    const ctx = new Context()
    await ctx.plugin(ChangeService)
    await ctx.plugin(SessionService)
    await ctx.plugin(AIReviewService)
    // Fake llm: review #1 reports an error finding; the fix call returns a
    // replacement file; review #2 comes back clean.
    let calls = 0
    ctx.provide('llm', {
      stream: async function* () {
        calls++
        if (calls === 1) {
          const text = JSON.stringify({
            risk: 'high', score: 40, summary: 'unsafe code',
            findings: [{ severity: 'error', file: 'src/Bug.java', title: 'Unsafe', description: 'x' }],
          })
          yield { type: 'text-delta', index: 0, text } as never
        } else if (calls === 2) {
          yield { type: 'text-delta', index: 0, text: '```java\npublic class Fixed {}\n```' } as never
        } else {
          const text = JSON.stringify({
            risk: 'low', score: 90, summary: 'clean',
            findings: [],
          })
          yield { type: 'text-delta', index: 0, text } as never
        }
        yield { type: 'finish', reason: { kind: 'stop' } } as never
      },
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'fake', model: 'fake' }),
    })
    await ctx.plugin(AIFixService)
    await ctx.plugin(ReviewFixLoopService)

    const { change, changeSession } = recordWithSession(ctx, 'loop-key-1', 'src/Bug.java', 'modify')

    const result = await ctx.fixLoop.run(changeSession.id, tempDir, 3)
    // With the mapping broken the loop never finds the change to fix:
    // fixedChangeIds stays empty and the loop ends at limit-reached.
    expect(result.fixedChangeIds).toContain(change.id)
    expect(result.stopped).toBe('pass')
    expect(calls).toBe(3)
  })
})

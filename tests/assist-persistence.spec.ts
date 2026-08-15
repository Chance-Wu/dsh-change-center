/**
 * F2 tests: AI review and risk results persist under
 * `$DSH_HOME/change-center/{review,risk}/` and restore on a cold start.
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'
import { AIReviewService } from '../src/review/AIReviewService.ts'
import { RiskService } from '../src/risk/RiskService.ts'

let tempRoot: string

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'dsh-assist-persist-'))
  process.env.DSH_HOME = tempRoot
})

afterAll(async () => {
  delete process.env.DSH_HOME
  // 异步(fire-and-forget)持久化可能仍在写;重试避免 ENOTEMPTY 竞态。
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * Persist is fire-and-forget (best-effort write through the fs seam). Poll
 * for the JSON file instead of sleeping a fixed 150ms — fixed sleeps race
 * the write when the suite runs in parallel workers.
 */
async function waitForFile(path: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`file not written in time: ${path}`)
}

function persistedRiskPath(sessionId: string): string {
  return join(tempRoot, 'change-center', 'risk', sessionId.replace(/[/\\]/g, '_') + '.json')
}

function persistedReviewPath(sessionId: string): string {
  return join(tempRoot, 'change-center', 'review', sessionId.replace(/[/\\]/g, '_') + '.json')
}

/** Fake llm returning one review JSON per stream call. */
function fakeReviewLlm(findings: unknown) {
  return {
    stream: async function* () {
      const text = JSON.stringify({ risk: 'high', score: 40, summary: 'unsafe', findings })
      yield { type: 'text-delta', index: 0, text } as never
      yield { type: 'finish', reason: { kind: 'stop' } } as never
    },
  }
}

function recordChange(ctx: Context, sessionId: string, path: string) {
  ctx.changeCenter.record({
    sessionId, cwd: tempRoot, kind: 'file',
    path, operation: 'modify', before: 'x\n', after: 'y\n',
    source: 'agent', toolName: 'edit',
  })
}

describe('AI review persistence', () => {
  it('restores a persisted review on a cold start', async () => {
    const first = new Context()
    await first.plugin(LocalFileSystem, { cwd: tempRoot })
    await first.plugin(ChangeService)
    await first.plugin(SessionService)
    first.provide('llm', fakeReviewLlm([
      { severity: 'error', file: 'src/Bug.java', line: 3, title: 'Unsafe', description: 'x' },
    ]))
    first.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fake', model: 'fake' }) })
    await first.plugin(AIReviewService)

    recordChange(first, 'review-persist-1', 'src/Bug.java')
    const sessionId = first.changeSessions.list()[0]!.id
    await first.aiReview.review(sessionId, first.changeSessions, tempRoot)
    await waitForFile(persistedReviewPath(sessionId))

    const second = new Context()
    await second.plugin(LocalFileSystem, { cwd: tempRoot })
    await second.plugin(AIReviewService)
    await second.aiReview.ensureLoaded()
    const restored = second.aiReview.get(sessionId)
    expect(restored).toBeDefined()
    expect(restored?.risk).toBe('high')
    expect(restored?.findings[0]?.title).toBe('Unsafe')
    expect(restored?.findings[0]?.filePath).toBe('src/Bug.java')
  })

  it('continues finding ids after restoring persisted reviews', async () => {
    const first = new Context()
    await first.plugin(LocalFileSystem, { cwd: tempRoot })
    await first.plugin(ChangeService)
    await first.plugin(SessionService)
    first.provide('llm', fakeReviewLlm([{ severity: 'warning', file: 'a.txt', title: 'A', description: 'x' }]))
    first.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fake', model: 'fake' }) })
    await first.plugin(AIReviewService)

    recordChange(first, 'review-persist-2', 'a.txt')
    const sessionId = first.changeSessions.list()[0]!.id
    await first.aiReview.review(sessionId, first.changeSessions, tempRoot)
    await waitForFile(persistedReviewPath(sessionId))

    const second = new Context()
    await second.plugin(LocalFileSystem, { cwd: tempRoot })
    await second.plugin(ChangeService)
    await second.plugin(SessionService)
    second.provide('llm', fakeReviewLlm([{ severity: 'info', file: 'b.txt', title: 'B', description: 'y' }]))
    second.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fake', model: 'fake' }) })
    await second.plugin(AIReviewService)
    await second.aiReview.ensureLoaded()

    // 新一轮审查生成的 finding id 不与已恢复的 finding-1 冲突。
    const again = await second.aiReview.review(sessionId, second.changeSessions, tempRoot)
    expect(again.findings[0]?.id).toBe('finding-2')
  })
})

describe('risk persistence', () => {
  it('restores a persisted risk result on a cold start', async () => {
    const first = new Context()
    await first.plugin(LocalFileSystem, { cwd: tempRoot })
    await first.plugin(ChangeService)
    await first.plugin(SessionService)
    await first.plugin(RiskService)

    recordChange(first, 'risk-persist-1', '/srv/db/app.sql')
    const sessionId = first.changeSessions.list()[0]!.id
    await first.risk.analyze(sessionId, first.changeCenter)
    await waitForFile(persistedRiskPath(sessionId))

    const second = new Context()
    await second.plugin(LocalFileSystem, { cwd: tempRoot })
    await second.plugin(ChangeService)
    await second.plugin(SessionService)
    await second.plugin(RiskService)
    await second.risk.ensureLoaded()
    const restored = second.risk.get(sessionId)
    expect(restored).toBeDefined()
    expect(restored?.level).toBe('high')
    expect(restored?.reasons.some(r => r.rule === 'sensitive-path')).toBe(true)
  })
})

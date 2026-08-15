/**
 * Real-HTTP route integration tests: mount the plugin's full service stack
 * plus the host webserver and drive `/api/change-center` with real fetch
 * requests. This covers the dispatch layer that route-table tests can't see —
 * the batch-op session-key mapping, risk/fix/loop routes, method checks, and
 * pagination all run end to end.
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { applyRoutes } from '../src/api/routes.ts'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'
import { ApplyService } from '../src/services/ApplyService.ts'
import { SnapshotService } from '../src/services/SnapshotService.ts'
import { JobService } from '../src/services/JobService.ts'
import { GitService } from '../src/git/GitService.ts'
import { VerificationService } from '../src/verification/VerificationService.ts'
import { AIReviewService } from '../src/review/AIReviewService.ts'
import { RiskService } from '../src/risk/RiskService.ts'
import { HistoryService } from '../src/history/HistoryService.ts'
import { PolicyService } from '../src/policy/PolicyService.ts'
import { AIFixService } from '../src/fix/AIFixService.ts'
import { ReviewFixLoopService } from '../src/loop/ReviewFixLoopService.ts'

let tempDir: string
let homeDir: string
let base: string
let ctx: Context
let port: number

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-routes-e2e-'))
  homeDir = mkdtempSync(join(tmpdir(), 'dsh-routes-home-'))
  // DSH_HOME 独立于 git workspace,避免 git add 遍历到 JSONL 原子写的暂存文件。
  process.env.DSH_HOME = homeDir

  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: tempDir })
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(BashLocal)
  await ctx.plugin(ChangeService)
  await ctx.plugin(SessionService)
  await ctx.plugin(ApplyService)
  await ctx.plugin(SnapshotService)
  await ctx.plugin(JobService)
  await ctx.plugin(GitService)
  await ctx.plugin(VerificationService)
  await ctx.plugin(AIReviewService)
  await ctx.plugin(RiskService)
  await ctx.plugin(HistoryService)
  await ctx.plugin(PolicyService)
  await ctx.plugin(AIFixService)
  await ctx.plugin(ReviewFixLoopService)
  // The loop's AI calls ride a fake llm provider (review → finding, fix →
  // replacement, re-review → clean).
  let calls = 0
  ctx.provide('llm', {
    stream: async function* () {
      calls++
      if (calls === 1) {
        const text = JSON.stringify({
          risk: 'high', score: 40, summary: 'unsafe',
          findings: [{ severity: 'error', file: 'src/Bug.java', title: 'Unsafe', description: 'x' }],
        })
        yield { type: 'text-delta', index: 0, text } as never
      } else if (calls === 2) {
        yield { type: 'text-delta', index: 0, text: '```java\npublic class Fixed {}\n```' } as never
      } else {
        const text = JSON.stringify({ risk: 'low', score: 90, summary: 'clean', findings: [] })
        yield { type: 'text-delta', index: 0, text } as never
      }
      yield { type: 'finish', reason: { kind: 'stop' } } as never
    },
  })
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fake', model: 'fake' }),
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  applyRoutes(ctx)

  port = ctx.webServer.port
  base = `http://127.0.0.1:${port}/api/change-center`
  // Wait for the listener to accept connections.
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${base}/sessions`)
      if (res.ok) break
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
})

afterAll(async () => {
  await ctx.fiber?.dispose()
  delete process.env.DSH_HOME
  // 异步(fire-and-forget)持久化可能仍在写;重试避免 ENOTEMPTY 竞态。
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  rmSync(tempDir, { recursive: true, force: true })
})

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, body: await res.json() }
}

async function postJson(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

/** Record a change for an agent session and return the change-session id. */
function record(agentKey: string, path: string, operation: 'create' | 'modify' | 'delete') {
  ctx.changeCenter.record({
    sessionId: agentKey, cwd: tempDir, kind: 'file',
    path, operation,
    before: operation === 'create' ? null : 'old\n',
    after: operation === 'delete' ? null : 'new\n',
    source: 'agent', toolName: 'edit',
  })
  return ctx.changeSessions.list()[0]!.id
}

describe('session-action over HTTP (agent-key mapping)', () => {
  it('apply-all reaches the change store through the change-session id', async () => {
    const agentKey = `e2e-batch-${Date.now()}`
    const target = join(tempDir, 'B.java')
    writeFileSync(target, 'new\n')
    const changeId = ctx.changeCenter.record({
      sessionId: agentKey, cwd: tempDir, kind: 'file',
      path: target, operation: 'create', before: null, after: 'new\n',
      source: 'agent', toolName: 'write',
    }).id
    const sessionId = ctx.changeSessions.list()[0]!.id
    expect(sessionId).not.toBe(agentKey)

    const { status, body } = await postJson(`/sessions/${sessionId}/apply-all`)
    expect(status).toBe(200)
    const result = (body as { result: { applied: string[] } }).result
    expect(result.applied).toContain(changeId)
    expect(ctx.changeCenter.get(changeId)?.status).toBe('applied')
  })

  it('rollback-all restores the file over HTTP', async () => {
    const agentKey = `e2e-rollback-${Date.now()}`
    const target = join(tempDir, 'C.java')
    // Capture-after semantics: the tool already wrote the file, so the disk
    // holds `after` at apply time; the snapshot preserves the true `before`.
    writeFileSync(target, 'edited\n')
    ctx.changeCenter.record({
      sessionId: agentKey, cwd: tempDir, kind: 'file',
      path: target, operation: 'modify', before: 'original\n', after: 'edited\n',
      source: 'agent', toolName: 'edit',
    })
    const sessionId = ctx.changeSessions.list()[0]!.id
    await postJson(`/sessions/${sessionId}/apply-all`)
    const { body } = await postJson(`/sessions/${sessionId}/rollback-all`)
    const result = (body as { result: { rolledBack: string[] } }).result
    expect(result.rolledBack).toHaveLength(1)
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(target, 'utf8')).toBe('original\n')
  })

  it('reports an unknown session instead of silently doing nothing', async () => {
    const { status, body } = await postJson('/sessions/session-999/apply-all')
    expect(status).toBe(200)
    expect((body as { error?: string }).error).toContain('unknown session')
  })
})

describe('risk route (key mapping)', () => {
  it('analyze sees the session changes over HTTP', async () => {
    const agentKey = `e2e-risk-${Date.now()}`
    const sessionId = record(agentKey, '/srv/db/app.sql', 'modify')
    const { body } = await postJson(`/sessions/${sessionId}/risk/analyze`)
    const risk = (body as { risk: { level: string; reasons: { rule: string }[] } }).risk
    expect(risk.level).toBe('high')
    expect(risk.reasons.some(r => r.rule === 'sensitive-path')).toBe(true)
  })
})

describe('git write routes (add/commit over HTTP)', () => {
  it('stages and commits through the session route', async () => {
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: tempDir })

    execSync('git config user.email t@e.com', { cwd: tempDir })
    execSync('git config user.name T', { cwd: tempDir })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(tempDir, 'tracked.txt'), 'one\n')
    execSync('git add tracked.txt && git commit -qm init', { cwd: tempDir })
    writeFileSync(join(tempDir, 'newfile.txt'), 'two\n')

    const agentKey = `e2e-git-${Date.now()}`
    ctx.changeCenter.record({
      sessionId: agentKey, cwd: tempDir, kind: 'file',
      path: join(tempDir, 'newfile.txt'), operation: 'create', before: null, after: 'two\n',
      source: 'agent', toolName: 'write',
    })
    const sessionId = ctx.changeSessions.list()[0]!.id

    const add = await postJson(`/sessions/${sessionId}/git/add`)
    expect(add.status).toBe(200)
    expect((add.body as { ok: boolean }).ok).toBe(true)

    const commit = await postJson(`/sessions/${sessionId}/git/commit`, { message: 'e2e commit' })
    expect(commit.status).toBe(200)
    expect((commit.body as { ok: boolean }).ok).toBe(true)

    const badCommit = await postJson(`/sessions/${sessionId}/git/commit`, {})
    expect((badCommit.body as { ok: boolean }).ok).toBe(false)
  })
})

describe('policy evaluation route', () => {
  it('reports the policies a session change hits', async () => {
    const agentKey = `e2e-policy-${Date.now()}`
    // deny-core-delete 命中 src/security/ 下的删除。
    const sessionId = record(agentKey, 'src/security/AuthConfig.java', 'delete')
    const { status, body } = await getJson(`/sessions/${sessionId}/policy-evaluation`)
    expect(status).toBe(200)
    const evaluations = (body as { evaluations: { policyId: string; action: string }[] }).evaluations
    expect(evaluations.some(e => e.policyId === 'deny-core-delete' && e.action === 'deny')).toBe(true)
  })
})

describe('fix loop route (key mapping)', () => {
  it('fixes a finding over HTTP and reports the fixed change', async () => {
    const agentKey = `e2e-loop-${Date.now()}`
    const changeId = ctx.changeCenter.record({
      sessionId: agentKey, cwd: tempDir, kind: 'file',
      path: 'src/Bug.java', operation: 'modify', before: 'x\n', after: 'y\n',
      source: 'agent', toolName: 'edit',
    }).id
    const sessionId = ctx.changeSessions.list()[0]!.id

    // The loop runs as a background job; poll it to completion.
    const { status, body } = await postJson(`/sessions/${sessionId}/loop/run`, { maxIterations: 3 })
    expect(status).toBe(200)
    const jobId = (body as { job: { id: string } }).job.id

    let job: { status: string; result?: { fixedChangeIds: string[]; stopped: string } } | null = null
    for (let i = 0; i < 40; i++) {
      const poll = await getJson(`/jobs/${jobId}`)
      job = (poll.body as { job: typeof job }).job
      if (job !== null && job.status !== 'running' && job.status !== 'pending') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(job?.status).toBe('completed')
    expect(job?.result?.fixedChangeIds).toContain(changeId)
    expect(job?.result?.stopped).toBe('pass')
  })
})

describe('method checks and pagination', () => {
  it('rejects GET on action routes and POST on read routes', async () => {
    const { status: getOnPost } = await getJson('/sessions/s-1/apply-all')
    expect(getOnPost).toBe(405)
    const { status: postOnGet } = await postJson('/sessions')
    expect(postOnGet).toBe(405)
  })

  it('paginates the session list and reports the total', async () => {
    const agentKey = `e2e-pages-${Date.now()}`
    for (let i = 0; i < 3; i++) {
      ctx.changeCenter.record({
        sessionId: agentKey, cwd: tempDir, kind: 'file',
        path: `p${i}.txt`, operation: 'create', before: null, after: 'x\n',
        source: 'agent', toolName: 'write',
      })
    }
    const { body } = await getJson('/sessions?limit=2')
    const page = body as { sessions: unknown[]; total: number }
    expect(page.sessions.length).toBe(2)
    expect(page.total).toBeGreaterThanOrEqual(3)
  })

  it('returns not-found for unknown paths', async () => {
    const { status } = await getJson('/nope')
    expect(status).toBe(404)
  })
})

/**
 * Phase-4 unit tests: policy rules and AI fix content extraction.
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { PolicyService } from '../src/policy/PolicyService.ts'
import { extractFencedContent } from '../src/fix/AIFixService.ts'
import { ChangeService } from '../src/services/ChangeService.ts'
import type { FileChange } from '../src/models/FileChange.ts'

describe('PolicyService', () => {
  let tempRoot: string

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dsh-policy-'))
    process.env.DSH_HOME = tempRoot
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(tempRoot, { recursive: true, force: true })
  })

  function makeChange(over: Partial<FileChange> = {}): FileChange {
    return {
      id: 'c1', sessionId: 's1', cwd: '/tmp', kind: 'file',
      path: 'src/demo/A.java', operation: 'modify',
      before: 'x\n', after: 'y\n', diff: '-x\n+y\n', status: 'pending',
      source: 'agent', toolName: 'edit', createdAt: 0, updatedAt: 0,
      ...over,
    }
  }

  it('denies deleting core security/config files', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(PolicyService)
    const evals = await ctx.policies.evaluate([
      makeChange({ path: 'src/security/AuthConfig.java', operation: 'delete' }),
    ])
    expect(evals.some(e => e.policyId === 'deny-core-delete' && e.action === 'deny')).toBe(true)
  })

  it('does not match unrelated changes', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(PolicyService)
    const evals = await ctx.policies.evaluate([makeChange({ path: 'src/demo/Util.java', operation: 'modify' })])
    expect(evals).toHaveLength(0)
  })

  it('persists user policy overrides', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: tempRoot })
    await ctx.plugin(PolicyService)
    await ctx.policies.save({ id: 'custom-deny', name: 'Deny secrets', enabled: true, priority: 200, conditions: [], action: 'deny' })
    const list = await ctx.policies.list()
    expect(list.some(p => p.id === 'custom-deny')).toBe(true)
  })
})

describe('AIFixService content extraction', () => {
  it('extracts content from a fenced response', () => {
    const text = '```java\npublic class A {}\n```'
    expect(extractFencedContent(text)).toBe('public class A {}')
  })

  it('falls back to raw text when no fence', () => {
    expect(extractFencedContent('plain content')).toBe('plain content')
  })
})

describe('ChangeService command kind', () => {
  it('records and applies a command change without re-running it', async () => {
    const ctx = new Context()
    await ctx.plugin(ChangeService)
    const change = ctx.changeCenter.record({
      sessionId: 's1', cwd: '/tmp', kind: 'command',
      path: 'npm install lodash', operation: 'execute',
      before: null, after: 'npm install lodash',
      source: 'agent', toolName: 'bash',
    })
    expect(change.kind).toBe('command')
    const result = await ctx.changeCenter.apply(change.id)
    expect(result.kind).toBe('applied')
    expect(ctx.changeCenter.get(change.id)?.status).toBe('applied')
  })
})

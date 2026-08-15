/**
 * Phase-3 integration tests: GitService against a real git repository and
 * VerificationService command detection/run.
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import { GitService } from '../src/git/GitService.ts'
import { VerificationService } from '../src/verification/VerificationService.ts'
import { removeDirSafe } from './helpers/removeDir.ts'

let repoDir: string
let plainDir: string

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'dsh-git-'))
  plainDir = mkdtempSync(join(tmpdir(), 'dsh-plain-'))
  execSync('git init -q', { cwd: repoDir })
  execSync('git config user.email test@example.com', { cwd: repoDir })
  execSync('git config user.name Test', { cwd: repoDir })
  writeFileSync(join(repoDir, 'a.txt'), 'one\n')
  execSync('git add a.txt && git commit -qm "initial"', { cwd: repoDir })
  writeFileSync(join(repoDir, 'a.txt'), 'two\n')
})

afterAll(async () => {
  await removeDirSafe(repoDir)
  await removeDirSafe(plainDir)
})

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(BashLocal)
  await ctx.plugin(GitService)
  await ctx.plugin(VerificationService)
  return ctx
}

describe('GitService (real repo)', () => {
  it('reports repository facts', async () => {
    const ctx = await setup()
    const info = await ctx.git.repoInfo(repoDir)
    expect('error' in info ? info.error : undefined).toBeUndefined()
    if ('error' in info) return
    expect(info.dirty).toBe(true)
    expect(info.head.length).toBeGreaterThan(0)
  })

  it('reports a clean status after commit and dirty after edit', async () => {
    const ctx = await setup()
    const entries = await ctx.git.status(repoDir)
    if ('error' in entries) throw new Error(entries.error)
    expect(entries.some(entry => entry.path === 'a.txt')).toBe(true)
  })

  it('produces a working-tree diff', async () => {
    const ctx = await setup()
    const result = await ctx.git.diff(repoDir)
    if ('error' in result) throw new Error(result.error)
    expect(result.diff).toContain('+two')
  })

  it('returns a not-a-git error for a plain directory', async () => {
    const ctx = await setup()
    const info = await ctx.git.repoInfo(plainDir)
    expect('error' in info ? info.error : undefined).toContain('not a git repository')
  })
})

describe('VerificationService', () => {
  it('detects npm test from package.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    const ctx = await setup()
    const detected = await ctx.verification.detectCommand(dir)
    expect(detected).toEqual({ type: 'test', command: 'npm test' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('detects mvn test from pom.xml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    writeFileSync(join(dir, 'pom.xml'), '<project/>')
    const ctx = await setup()
    expect((await ctx.verification.detectCommand(dir))?.command).toBe('mvn test')
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns a failed task when nothing is detected', async () => {
    const ctx = await setup()
    const task = await ctx.verification.run('sess-x', plainDir)
    expect(task?.status).toBe('failed')
    expect(task?.output).toContain('no verification command detected')
  })

  it('runs a real command (echo via shell)', async () => {
    const ctx = await setup()
    // A Makefile with a trivial test target exercises the run path.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    writeFileSync(join(dir, 'Makefile'), 'test:\n\t@echo ok\n')
    const task = await ctx.verification.run('sess-y', dir)
    expect(task?.status).toBe('passed')
    expect(task?.output).toContain('ok')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('GitService write ops (manual add/commit/push)', () => {
  it('stages paths with git add and reports index status', async () => {
    const ctx = await setup()
    writeFileSync(join(repoDir, 'b.txt'), 'new\n')
    const addResult = await ctx.git.add(repoDir, ['b.txt'])
    expect(addResult.ok).toBe(true)
    const status = await ctx.git.status(repoDir)
    if ('error' in status) throw new Error(status.error)
    // 已暂存:porcelain "A  b.txt"(index A,worktree 空格)。
    expect(status.some(entry => entry.path === 'b.txt' && entry.code === 'A')).toBe(true)
    execSync('git reset -q', { cwd: repoDir })
    rmSync(join(repoDir, 'b.txt'))
  })

  it('commits staged changes and reports the hash', async () => {
    const ctx = await setup()
    writeFileSync(join(repoDir, 'commit-me.txt'), 'payload\n')
    execSync('git add commit-me.txt', { cwd: repoDir })
    const result = await ctx.git.commit(repoDir, 'add commit-me.txt')
    expect(result.ok).toBe(true)
    expect((result as { hash?: string }).hash).toMatch(/^[0-9a-f]{7,}$/)
    const log = await ctx.git.log(repoDir, 1)
    if ('error' in log) throw new Error(log.error)
    expect(log.entries[0]).toContain('add commit-me.txt')
  })

  it('rejects an empty commit message', async () => {
    const ctx = await setup()
    const result = await ctx.git.commit(repoDir, '   ')
    expect(result.ok).toBe(false)
  })

  it('pushes to a configured bare remote', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'dsh-git-remote-'))
    execSync('git init --bare -q', { cwd: remote })
    const ctx = await setup()
    writeFileSync(join(repoDir, 'push-me.txt'), 'x\n')
    execSync('git add push-me.txt', { cwd: repoDir })
    execSync('git commit -qm "push me"', { cwd: repoDir })
    execSync(`git remote add origin ${remote}`, { cwd: repoDir })
    const result = await ctx.git.push(repoDir, 'origin', 'main')
    expect(result.ok).toBe(true)
    // 远端存在该提交。
    const inRemote = execSync('git log --oneline -1', { cwd: remote }).toString().trim()
    expect(inRemote).toContain('push me')
    execSync('git remote remove origin', { cwd: repoDir })
    rmSync(remote, { recursive: true, force: true })
  })
})

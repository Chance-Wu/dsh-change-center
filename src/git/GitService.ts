/**
 * Git integration: repository facts, working-tree status, diff, and log
 * through the Harness shell seam (`ctx.shell.run`).
 *
 * Harness ships no git package, so every operation shells out to the `git`
 * CLI in the session workspace. The service is deliberately read-only in P0:
 * no commit, no push, no history rewriting.
 * @module dsh-change-center/git
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls `ctx.shell` and its result types into scope.
import type {} from '@deepseek-ai/dsh-shell'
import type { GitInfo, GitStatusEntry } from '../models/Phase3.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    git: GitService
  }
}

/** Git facts for one workspace; error carries a non-git marker. */
export type GitWorkspaceResult = GitInfo & { entries?: GitStatusEntry[] } | { error: string }

const GIT_TIMEOUT_MS = 15_000

/** Executes read-only git commands in a session's workspace. */
export class GitService extends Service {
  static inject = ['shell']

  constructor(ctx: Context) {
    super(ctx, 'git')
  }

  /** Repository facts (root/branch/HEAD/dirty) for a session's workspace. */
  async repoInfo(workspace: string): Promise<GitWorkspaceResult> {
    const [branch, head, dirty] = await Promise.all([
      this.git(workspace, 'git rev-parse --abbrev-ref HEAD'),
      this.git(workspace, 'git rev-parse --short HEAD'),
      this.git(workspace, 'git status --porcelain'),
    ])
    if (branch.error !== undefined || head.error !== undefined) {
      return { error: branch.error ?? head.error ?? 'not a git repository' }
    }
    return {
      root: workspace,
      branch: (branch.stdout ?? '').trim() || 'HEAD',
      head: (head.stdout ?? '').trim() || 'unknown',
      dirty: (dirty.stdout ?? '').trim().length > 0,
    }
  }

  /** Parsed working-tree status entries (porcelain short codes). */
  async status(workspace: string): Promise<GitStatusEntry[] | { error: string }> {
    const result = await this.git(workspace, 'git status --porcelain')
    if (result.error !== undefined) return { error: result.error }
    const entries: GitStatusEntry[] = []
    for (const line of (result.stdout ?? '').split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      // Porcelain format: "XY path" where X is the index status and Y the
      // worktree status; trimmed of the leading space, the code is one char
      // plus a separating space, and the path follows at index 2.
      const code = trimmed[0] ?? '?'
      const path = trimmed.slice(2)
      if (path.length > 0) entries.push({ code, path })
    }
    return entries
  }

  /** Working-tree diff (unified, no color), or an error for non-git dirs. */
  async diff(workspace: string): Promise<{ diff: string } | { error: string }> {
    const result = await this.git(workspace, 'git diff --no-color')
    if (result.error !== undefined) return { error: result.error }
    return { diff: (result.stdout ?? '').trimEnd() }
  }

  /** Recent commit log lines (short hash + subject). */
  async log(workspace: string, count = 20): Promise<{ entries: string[] } | { error: string }> {
    const result = await this.git(workspace, `git log --oneline -${count}`)
    if (result.error !== undefined) return { error: result.error }
    return { entries: (result.stdout ?? '').split('\n').filter(line => line.trim().length > 0) }
  }

  /** Run one git command in the workspace; never throws on non-zero exit. */
  private async git(workspace: string, command: string): Promise<{ stdout?: string; error?: string }> {
    const shell = this.ctx.get('shell')
    if (shell === undefined) return { error: 'shell unavailable' }
    try {
      const spec = shell.resolve({ command, workdir: workspace, timeoutMs: GIT_TIMEOUT_MS })
      const result = await shell.run(spec)
      if (result.exitCode !== 0) {
        const stderr = result.stderr.text ?? ''
        // git prints "not a git repository" — surface it distinctly.
        if (/not a git repository/i.test(stderr) || /fatal:/i.test(stderr)) {
          return { error: 'not a git repository' }
        }
        return { error: stderr.trim() || `git exited ${result.exitCode}` }
      }
      return { stdout: result.stdout.text ?? '' }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}

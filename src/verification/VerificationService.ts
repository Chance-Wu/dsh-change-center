/**
 * Verification engine: detects a project-appropriate verification command
 * and runs it in the session workspace.
 *
 * Detection is heuristic (package.json → npm test, pom.xml → mvn test, …);
 * the detected command is executed through `ctx.shell.run` and its exit code
 * and output recorded on a {@link VerificationTask}. P0 runs foreground with
 * a bounded timeout — no background job queue yet.
 * @module dsh-change-center/verification
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls `ctx.shell` into scope.
import type {} from '@deepseek-ai/dsh-shell'
import type { VerificationTask, VerificationType } from '../models/Phase3.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    verification: VerificationService
  }
}

const VERIFY_TIMEOUT_MS = 120_000

/** A detected verification command candidate. */
interface DetectedCommand {
  type: VerificationType
  command: string
}

/** Ordered detection rules: workspace-relative file → command. */
const DETECTION_RULES: { file: string; type: VerificationType; command: string }[] = [
  { file: 'package.json', type: 'test', command: 'npm test' },
  { file: 'pom.xml', type: 'test', command: 'mvn test' },
  { file: 'build.gradle', type: 'test', command: './gradlew test' },
  { file: 'build.gradle.kts', type: 'test', command: './gradlew test' },
  { file: 'Cargo.toml', type: 'test', command: 'cargo test' },
  { file: 'go.mod', type: 'test', command: 'go test ./...' },
  { file: 'Makefile', type: 'test', command: 'make test' },
]

/** Runs and tracks verification tasks for a session's workspace. */
export class VerificationService extends Service {
  static inject = ['shell']

  private readonly tasks = new Map<string, VerificationTask[]>()
  private nextId = 1

  constructor(ctx: Context) {
    super(ctx, 'verification')
  }

  /** All tasks for a session, newest first. */
  list(sessionId: string): VerificationTask[] {
    return [...(this.tasks.get(sessionId) ?? [])].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  }

  /** Detect the verification command for a workspace (first matching rule). */
  async detectCommand(workspace: string): Promise<DetectedCommand | undefined> {
    const fs = this.ctx.get('fs')
    for (const rule of DETECTION_RULES) {
      let exists: boolean
      if (fs !== undefined) {
        const target = await fs.resolve(join(workspace, rule.file))
        exists = (await fs.stat(target)) !== undefined
      } else {
        // Fallback for fs-less compositions (pure state-machine tests).
        exists = existsSync(join(workspace, rule.file))
      }
      if (exists) return { type: rule.type, command: rule.command }
    }
    return undefined
  }

  /**
   * Run the detected verification command for a session's workspace.
   * @param sessionId - the change session id.
   * @param workspace - the workspace path to run in.
   * @param opts - optional cancellation signal (honored by the shell run).
   * @returns the finished task (passed/failed), or undefined when no command
   *   was detected.
   */
  async run(sessionId: string, workspace: string, opts?: { signal?: AbortSignal }): Promise<VerificationTask | undefined> {
    const detected = await this.detectCommand(workspace)
    const task: VerificationTask = {
      id: `verify-${this.nextId++}`,
      sessionId,
      type: detected?.type ?? 'test',
      command: detected?.command ?? '(none detected)',
      status: 'pending',
      startedAt: Date.now(),
    }
    this.push(sessionId, task)
    if (detected === undefined) {
      task.status = 'failed'
      task.output = 'no verification command detected (package.json/pom.xml/build.gradle/Cargo.toml/go.mod/Makefile)'
      task.finishedAt = Date.now()
      this.ctx.emit('verification:completed', task)
      return task
    }
    task.status = 'running'
    const shell = this.ctx.get('shell')
    if (shell === undefined) {
      task.status = 'failed'
      task.output = 'shell unavailable'
      task.finishedAt = Date.now()
      this.ctx.emit('verification:completed', task)
      return task
    }
    try {
      const spec = shell.resolve({
        command: task.command,
        workdir: workspace,
        timeoutMs: VERIFY_TIMEOUT_MS,
        ...opts?.signal !== undefined ? { signal: opts.signal } : {},
      })
      const result = await shell.run(spec)
      task.exitCode = result.exitCode ?? undefined
      task.output = [
        result.stdout.text ? `[stdout]\n${result.stdout.text}` : '',
        result.stderr.text ? `[stderr]\n${result.stderr.text}` : '',
      ].filter(Boolean).join('\n')
      task.status = result.exitCode === 0 ? 'passed' : 'failed'
    } catch (error) {
      task.status = 'failed'
      task.output = error instanceof Error ? error.message : String(error)
    }
    task.finishedAt = Date.now()
    this.ctx.emit('verification:completed', task)
    return task
  }

  private push(sessionId: string, task: VerificationTask): void {
    const list = this.tasks.get(sessionId) ?? []
    list.push(task)
    this.tasks.set(sessionId, list)
  }
}

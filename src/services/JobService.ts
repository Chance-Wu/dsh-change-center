/**
 * Job service: generic background jobs with progress state and cancellation.
 *
 * Long-running work (verification, AI review, AI fix, the review-fix loop)
 * is submitted as a job; the submit call returns immediately with a pending
 * job, the work runs off the HTTP request path, and the job settles to
 * completed / failed / cancelled. Each job carries an {@link AbortSignal} so
 * callers can cancel the underlying shell/LLM work, which both
 * `ctx.shell` and `ctx.llm` honor.
 * @module dsh-change-center/services
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** Lifecycle status of one background job. */
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/** One background job; `result` holds the wrapped function's return value. */
export interface Job<T = unknown> {
  id: string
  sessionId: string
  label: string
  status: JobStatus
  result?: T
  error?: string
  createdAt: number
  finishedAt?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    jobs: JobService
  }
  interface Events {
    /** A background job started running. */
    'job.started'(job: Job): void
    /** A background job settled (completed / failed / cancelled). */
    'job.settled'(job: Job): void
  }
}

/** Runs background jobs with a cancellable AbortController per job. */
export class JobService extends Service {
  private readonly jobs = new Map<string, Job>()
  private readonly controllers = new Map<string, AbortController>()
  private nextId = 1

  constructor(ctx: Context) {
    super(ctx, 'jobs')
  }

  /**
   * Submit a background job and return immediately.
   * @param sessionId - owning change session id (for listing).
   * @param label - human-readable job label.
   * @param fn - the long-running work; must honor `signal.aborted` promptly.
   */
  submit<T>(sessionId: string, label: string, fn: (signal: AbortSignal) => Promise<T>): Job<T> {
    const job: Job<T> = {
      id: `job-${this.nextId++}`,
      sessionId,
      label,
      status: 'pending',
      createdAt: Date.now(),
    }
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    this.jobs.set(job.id, job)
    // Defer the start so the caller observes the job as `pending` first.
    queueMicrotask(() => {
      void this.run(job, controller, fn)
    })
    return job
  }

  /** One job by id. */
  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  /** Jobs for a session, newest first (id desc breaks same-ms ties). */
  listBySession(sessionId: string): Job[] {
    return [...this.jobs.values()]
      .filter(job => job.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  }

  /** Cancel a running/pending job (aborts its signal); returns the job. */
  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id)
    if (job === undefined) return undefined
    const terminal: JobStatus[] = ['completed', 'failed', 'cancelled']
    if (terminal.includes(job.status)) return job
    this.controllers.get(id)?.abort()
    return job
  }

  private async run<T>(
    job: Job<T>,
    controller: AbortController,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<void> {
    // Cancelled before the work started: settle immediately without invoking
    // fn (its abort listener would never fire on an already-aborted signal).
    if (controller.signal.aborted) {
      job.status = 'cancelled'
      job.finishedAt = Date.now()
      this.controllers.delete(job.id)
      this.ctx.emit('job.settled', job)
      return
    }
    job.status = 'running'
    this.ctx.emit('job.started', job)
    try {
      job.result = await fn(controller.signal)
      job.status = controller.signal.aborted ? 'cancelled' : 'completed'
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed'
      if (job.status === 'failed') {
        job.error = error instanceof Error ? error.message : String(error)
      }
    }
    job.finishedAt = Date.now()
    this.controllers.delete(job.id)
    this.ctx.emit('job.settled', job)
  }
}

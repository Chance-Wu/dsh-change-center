/**
 * JobService tests: background jobs settle to completed / failed / cancelled,
 * emit `job.settled`, and honor cancellation through their AbortSignal.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { JobService } from '../src/services/JobService.ts'
import type { Job } from '../src/services/JobService.ts'

/** Poll until `check` is true (background jobs settle asynchronously). */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('JobService', () => {
  it('settles a completed job with its result and emits job.settled', async () => {
    const ctx = new Context()
    await ctx.plugin(JobService)
    const settled: string[] = []
    ctx.on('job.settled', (job: Job) => { settled.push(job.id) })

    const job = ctx.jobs.submit('s-1', 'test-job', async () => 42)
    expect(job.status).toBe('pending')

    await waitFor(() => job.status === 'completed')
    expect(job.result).toBe(42)
    expect(settled).toContain(job.id)
  })

  it('fails a job whose work throws', async () => {
    const ctx = new Context()
    await ctx.plugin(JobService)
    const job = ctx.jobs.submit('s-2', 'boom', async () => {
      throw new Error('kaboom')
    })
    await waitFor(() => job.status === 'failed')
    expect(job.error).toBe('kaboom')
  })

  it('cancels a running job via its AbortSignal', async () => {
    const ctx = new Context()
    await ctx.plugin(JobService)
    // Abort-aware work must check `aborted` first: an already-aborted signal
    // never fires its listeners again.
    const job = ctx.jobs.submit('s-3', 'slow', (signal) => new Promise<string>((resolve, reject) => {
      if (signal.aborted) { reject(new Error('aborted')); return }
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    ctx.jobs.cancel(job.id)
    await waitFor(() => job.status === 'cancelled')
    expect(job.finishedAt).toBeTypeOf('number')
  })

  it('settles a job cancelled before its work started', async () => {
    const ctx = new Context()
    await ctx.plugin(JobService)
    const job = ctx.jobs.submit('s-4', 'never-runs', () => new Promise<string>(() => {
      // Never settles; the job must still settle via the pre-start cancel
      // fast path, not by invoking fn.
    }))
    // Cancel synchronously, before the deferred start microtask runs.
    ctx.jobs.cancel(job.id)
    await waitFor(() => job.status === 'cancelled')
    expect(job.finishedAt).toBeTypeOf('number')
  })

  it('lists jobs per session, newest first', async () => {
    const ctx = new Context()
    await ctx.plugin(JobService)
    const a = ctx.jobs.submit('s-a', 'one', async () => 1)
    const b = ctx.jobs.submit('s-a', 'two', async () => 2)
    ctx.jobs.submit('s-b', 'other', async () => 3)
    const jobs = ctx.jobs.listBySession('s-a')
    expect(jobs.map(j => j.id)).toEqual([b.id, a.id])
  })

  it('cancel of an unknown id returns undefined', async () => {
    const ctx = new Context()
    await ctx.plugin(JobService)
    expect(ctx.jobs.cancel('nope')).toBeUndefined()
  })
})

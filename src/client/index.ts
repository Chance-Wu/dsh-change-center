/**
 * dsh-change-center browser half: registers a conversation "Changes" tab
 * (alongside Chat/Trajectory) plus a settings section. Both render the
 * change-review surface.
 *
 * Data is fetched from the host through the same-origin `/api/change-center`
 * routes mounted by the host half — no RPC plumbing, no shared state.
 * @module dsh-change-center/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section'
// entry) and the conversation view tab merge ('conversation.view') into scope.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createElement } from 'react'
// Wire types are the host models themselves (type-only imports; erased at
// bundle time) so the client never drifts from the host's data shapes.
import type { FileChange } from '../models/FileChange.ts'
import type { ChangeSession } from '../models/ChangeSession.ts'
import type { ChangeEvent, ChangeRisk, ReviewFinding, ReviewResult, VerificationTask } from '../models/Phase3.ts'
import type { ChangePolicy, FixRequest, FixResult } from '../models/Phase4.ts'
import type { AcceptAllResult } from '../services/ChangeService.ts'
import type { Job } from '../services/JobService.ts'
import { ChangeCenterSection } from './ChangeCenterSection.tsx'
import { ChangesTab, type ChangesTabInjected } from './ChangesTab.tsx'

/** Required services for slot registration. */
export const inject = ['slots']

/**
 * Browser plugin body: mount the Changes conversation tab and the settings
 * section, both rendering the change-review surface.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Conversation tab: shows the current session's captured changes.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'changes',
    order: 20,
    label: '变更',
    inject: (sessionId: string): ChangesTabInjected => ({ sessionId }),
  }, (props: ChangesTabInjected) => {
    return createElement(ChangesTab, { ...props, api: apiOf() })
  }))

  // Settings section: global session list.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'change-center',
    order: 90,
    label: '变更中心',
  }, (props: SettingsSectionOwnerProps) => {
    return createElement(ChangeCenterSection, { ...props, api: apiOf() })
  }))
}

/** Wire shape of a captured change — the host {@link FileChange} model. */
export type WireChange = FileChange

/** Wire shape of a change session — the host {@link ChangeSession} model. */
export type WireSession = ChangeSession

/** Wire shape of an accept-all-and-apply result — the host type. */
export type WireAcceptAllResult = AcceptAllResult

/** Result of a change action (apply/rollback). */
export interface ActionResult {
  kind?: string
  error?: string
  currentHash?: string
  beforeHash?: string
}

/** Wire shape of a git status response. */
export interface GitResponse {
  repo?: { root: string; branch: string; head: string; dirty: boolean; error?: string } | { error: string }
  entries?: { code: string; path: string }[]
  diff?: string
}

/** Wire shape of a verification task — the host {@link VerificationTask}. */
export type WireVerificationTask = VerificationTask

/** Wire shape of a review finding — the host {@link ReviewFinding}. */
export type WireFinding = ReviewFinding

/** Wire shape of an AI review result — the host {@link ReviewResult}. */
export type WireReview = ReviewResult

/** Wire shape of a risk result — the host {@link ChangeRisk}. */
export type WireRisk = ChangeRisk

/** Wire shape of a history/timeline event — the host {@link ChangeEvent}. */
export type WireHistoryEvent = ChangeEvent

/** Wire shape of a change policy — the host {@link ChangePolicy}. */
export type WirePolicy = ChangePolicy

/** Wire shape of a fix request — the host {@link FixRequest}. */
export type WireFixRequest = FixRequest

/** Wire shape of a fix result — the host {@link FixResult}. */
export type WireFixResult = FixResult

/** Wire shape of a background job — the host {@link Job}. */
export type WireJob = Job

/** A subscription handle; call it to stop receiving events. */
export type Unsubscribe = () => void

/** Minimal API surface the section consumes. */
export interface ChangeCenterApi {
  listChanges(): Promise<WireChange[]>
  listSessions(): Promise<WireSession[]>
  sessionChanges(sessionId: string): Promise<WireChange[]>
  changeAction(id: string, action: 'approve' | 'reject' | 'rollback' | 'repend'): Promise<ActionResult>
  applyChange(id: string, force?: boolean): Promise<ActionResult>
  editChange(id: string, after: string): Promise<unknown>
  sessionAction(sessionId: string, action: 'accept-all' | 'reject-all'): Promise<{ updated: string[] }>
  acceptAllAndApply(sessionId: string): Promise<WireAcceptAllResult>
  gitStatus(sessionId: string): Promise<GitResponse>
  gitDiff(sessionId: string): Promise<GitResponse>
  gitLog(sessionId: string): Promise<GitResponse>
  verificationList(sessionId: string): Promise<WireVerificationTask[]>
  verificationRun(sessionId: string): Promise<JobHandle<WireVerificationTask | undefined>>
  reviewGet(sessionId: string): Promise<WireReview | null>
  reviewRun(sessionId: string): Promise<JobHandle<WireReview>>
  riskGet(sessionId: string): Promise<WireRisk | null>
  riskAnalyze(sessionId: string): Promise<WireRisk>
  history(sessionId: string): Promise<WireHistoryEvent[]>
  timeline(sessionId: string): Promise<{ events: WireHistoryEvent[] }>
  policies(): Promise<WirePolicy[]>
  policySave(policy: WirePolicy): Promise<WirePolicy[]>
  policyDelete(id: string): Promise<WirePolicy[]>
  fixList(sessionId: string): Promise<WireFixRequest[]>
  fixRun(sessionId: string, reviewId: string, findingId: string, changeId: string): Promise<JobHandle<WireFixResult>>
  loopRun(sessionId: string, maxIterations?: number): Promise<JobHandle<{ result: { iterations: number; stopped: string } }>>
  jobGet(id: string): Promise<{ job: WireJob | null }>
  jobCancel(id: string): Promise<{ job: WireJob | null }>
  sessionJobs(sessionId: string): Promise<{ jobs: WireJob[] }>
  /** Subscribe to the host event stream; returns an unsubscribe handle. */
  subscribeEvents(onEvent: (event: string) => void): Unsubscribe
}

/**
 * Same-origin fetch client for the change-center API. Client bundles run on
 * the served origin, so relative `/api/change-center` reaches the host
 * routes mounted by the host half.
 */
export function apiOf(): ChangeCenterApi {
  return {
    listChanges: () => getJson('/api/change-center/changes').then(body => (body as { changes: WireChange[] }).changes),
    listSessions: () => getJson('/api/change-center/sessions').then(body => (body as { sessions: WireSession[] }).sessions),
    sessionChanges: (sessionId) =>
      getJson(`/api/change-center/sessions/${sessionId}/changes`).then(body => (body as { changes: WireChange[] }).changes),
    changeAction: (id, action) =>
      postJson(`/api/change-center/changes/${id}/${action}`).then(body => body as ActionResult),
    applyChange: (id, force) =>
      postJson(`/api/change-center/changes/${id}/apply${force ? '?force=1' : ''}`).then(body => body as ActionResult),
    editChange: (id, after) => postJson(`/api/change-center/changes/${id}/edit`, { after }),
    sessionAction: (sessionId, action) =>
      postJson(`/api/change-center/sessions/${sessionId}/${action}`).then(body => body as { updated: string[] }),
    acceptAllAndApply: (sessionId) =>
      postJson(`/api/change-center/sessions/${sessionId}/accept-all-apply`).then(body => (body as { result: WireAcceptAllResult }).result),
    gitStatus: (sessionId) => getJson(`/api/change-center/sessions/${sessionId}/git`).then(body => body as GitResponse),
    gitDiff: (sessionId) => getJson(`/api/change-center/sessions/${sessionId}/git/diff`).then(body => body as GitResponse),
    gitLog: (sessionId) => getJson(`/api/change-center/sessions/${sessionId}/git/log`).then(body => body as GitResponse),
    verificationList: (sessionId) =>
      getJson(`/api/change-center/sessions/${sessionId}/verification`).then(body => (body as { tasks: WireVerificationTask[] }).tasks),
    verificationRun: (sessionId) => submitJobHandle(
      () => postJson(`/api/change-center/sessions/${sessionId}/verification/run`) as Promise<{ job: { id: string } }>,
      job => job.result as WireVerificationTask | undefined,
    ),
    reviewGet: (sessionId) =>
      getJson(`/api/change-center/sessions/${sessionId}/review`).then(body => (body as { review: WireReview | null }).review),
    reviewRun: (sessionId) => submitJobHandle(
      () => postJson(`/api/change-center/sessions/${sessionId}/review/run`) as Promise<{ job: { id: string } }>,
      job => job.result as WireReview,
    ),
    riskGet: (sessionId) =>
      getJson(`/api/change-center/sessions/${sessionId}/risk`).then(body => (body as { risk: WireRisk | null }).risk),
    riskAnalyze: (sessionId) =>
      postJson(`/api/change-center/sessions/${sessionId}/risk/analyze`).then(body => (body as { risk: WireRisk }).risk),
    history: (sessionId) =>
      getJson(`/api/change-center/sessions/${sessionId}/history`).then(body => (body as { events: WireHistoryEvent[] }).events),
    timeline: (sessionId) =>
      getJson(`/api/change-center/sessions/${sessionId}/history/timeline`).then(body => body as { events: WireHistoryEvent[] }),
    policies: () => getJson('/api/change-center/policies').then(body => (body as { policies: WirePolicy[] }).policies),
    policySave: (policy) => postJson('/api/change-center/policies', policy).then(body => (body as { policies: WirePolicy[] }).policies),
    policyDelete: (id) => postJson(`/api/change-center/policies/${id}/delete`).then(body => (body as { policies: WirePolicy[] }).policies),
    fixList: (sessionId) =>
      getJson(`/api/change-center/sessions/${sessionId}/fix`).then(body => (body as { requests: WireFixRequest[] }).requests),
    fixRun: (sessionId, reviewId, findingId, changeId) => submitJobHandle(
      () => postJson(`/api/change-center/sessions/${sessionId}/fix/run`, { reviewId, findingId, changeId }) as Promise<{ job: { id: string } }>,
      job => job.result as WireFixResult,
    ),
    loopRun: (sessionId, maxIterations) => submitJobHandle(
      () => postJson(`/api/change-center/sessions/${sessionId}/loop/run`, { maxIterations }) as Promise<{ job: { id: string } }>,
      job => ({ result: job.result as { iterations: number; stopped: string } }),
    ),
    jobGet: (id) => getJson(`/api/change-center/jobs/${id}`).then(body => body as { job: WireJob | null }),
    jobCancel: (id) => postJson(`/api/change-center/jobs/${id}/cancel`).then(body => body as { job: WireJob | null }),
    sessionJobs: (sessionId) =>
      getJson(`/api/change-center/sessions/${sessionId}/jobs`).then(body => body as { jobs: WireJob[] }),
    subscribeEvents: (onEvent) => {
      const source = new EventSource('/api/change-center/events')
      for (const name of ['change:created', 'change-session:created', 'change-session:status', 'job:settled']) {
        source.addEventListener(name, () => onEvent(name))
      }
      return () => source.close()
    },
  }
}

/** A running background job handle: await `done`, or cancel it. */
export interface JobHandle<T> {
  jobId: string
  /** Resolves with the unwrapped result when the job settles. */
  done: Promise<T>
  /** Cancel the job (aborts the host-side work); callers may fire-and-forget. */
  cancel: () => Promise<void>
}

/**
 * Submit a background job and return a handle immediately: `done` polls the
 * job endpoint until it settles, `cancel` aborts it via the jobs API.
 */
export function submitJobHandle<T>(
  submit: () => Promise<{ job: { id: string } }>,
  unwrap: (job: { status: string; result?: unknown; error?: string }) => T,
  timeoutMs = 180_000,
): Promise<JobHandle<T>> {
  return submit().then(({ job }) => {
    let cancelled = false
    const done = new Promise<T>((resolve, reject) => {
      const poll = async (): Promise<void> => {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const body = await getJson(`/api/change-center/jobs/${job.id}`) as { job: { status: string; result?: unknown; error?: string } }
          const current = body.job
          if (current.status === 'completed') { resolve(unwrap(current)); return }
          if (current.status === 'failed') { reject(new Error(current.error ?? 'change-center: job failed')); return }
          if (current.status === 'cancelled') { reject(new Error('change-center: job cancelled')); return }
          if (Date.now() > deadline) { reject(new Error('change-center: job timed out')); return }
          await new Promise(resolve2 => setTimeout(resolve2, 300))
        }
      }
      void poll()
    })
    return {
      jobId: job.id,
      done,
      cancel: async () => {
        if (cancelled) return
        cancelled = true
        await postJson(`/api/change-center/jobs/${job.id}/cancel`)
      },
    }
  })
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error(`change-center: GET ${path} failed with ${response.status}`)
  }
  return response.json()
}

async function postJson(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    throw new Error(`change-center: POST ${path} failed with ${response.status}`)
  }
  return response.json()
}

export type { ChangeCenterSectionProps } from './ChangeCenterSection.tsx'

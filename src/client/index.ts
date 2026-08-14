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

/** The wire shape of a captured change (mirrors the host model). */
export interface WireChange {
  id: string
  sessionId: string
  cwd: string
  kind?: 'file' | 'command' | 'external'
  path: string
  operation: 'create' | 'modify' | 'delete' | 'rename' | 'execute'
  before: string | null
  after: string | null
  diff: string
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed' | 'rolled_back'
  toolName: string
  createdAt: number
  updatedAt: number
}

/** The wire shape of a change session. */
export interface WireSession {
  id: string
  name: string
  status: 'active' | 'completed' | 'cancelled' | 'failed'
  agentSessionId: string
  workspace: string
  changeIds: string[]
  statistics: { files: number; additions: number; deletions: number }
  createdAt: number
  updatedAt: number
}

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

/** Wire shape of a verification task. */
export interface WireVerificationTask {
  id: string
  sessionId: string
  type: string
  command: string
  status: 'pending' | 'running' | 'passed' | 'failed' | 'cancelled'
  exitCode?: number
  output?: string
  startedAt?: number
  finishedAt?: number
}

/** Wire shape of a review finding. */
export interface WireFinding {
  id: string
  severity: string
  filePath: string
  line?: number
  title: string
  description: string
  suggestion?: string
}

/** Wire shape of an AI review result. */
export interface WireReview {
  sessionId: string
  summary: string
  risk: string
  score: number
  findings: WireFinding[]
}

/** Wire shape of a risk result. */
export interface WireRisk {
  level: string
  score: number
  reasons: { rule: string; level: string; detail: string }[]
}

/** Wire shape of a history/timeline event. */
export interface WireHistoryEvent {
  id: string
  sessionId: string
  changeId?: string
  type: string
  actor: string
  timestamp: number
  metadata?: Record<string, unknown>
}

/** Wire shape of a change policy. */
export interface WirePolicy {
  id: string
  name: string
  enabled: boolean
  priority: number
  conditions: { type: string; operator: string; value: unknown }[]
  action: 'allow' | 'warn' | 'deny'
}

/** Wire shape of a policy evaluation result. */
export interface WirePolicyEvaluation {
  policyId: string
  action: string
  reason: string
}

/** Wire shape of a fix request. */
export interface WireFixRequest {
  id: string
  reviewId: string
  findingId: string
  sessionId: string
  changeId: string
  status: string
  instruction: string
  resultSummary?: string
}

/** Wire shape of a fix result. */
export interface WireFixResult {
  fixRequestId: string
  changeIds: string[]
  summary: string
}

/** Minimal API surface the section consumes. */
export interface ChangeCenterApi {
  listChanges(): Promise<WireChange[]>
  listSessions(): Promise<WireSession[]>
  sessionChanges(sessionId: string): Promise<WireChange[]>
  changeAction(id: string, action: 'approve' | 'reject' | 'rollback'): Promise<ActionResult>
  applyChange(id: string, force?: boolean): Promise<ActionResult>
  editChange(id: string, after: string): Promise<unknown>
  sessionAction(sessionId: string, action: 'accept-all' | 'reject-all'): Promise<{ updated: string[] }>
  gitStatus(sessionId: string): Promise<GitResponse>
  gitDiff(sessionId: string): Promise<GitResponse>
  gitLog(sessionId: string): Promise<GitResponse>
  verificationList(sessionId: string): Promise<WireVerificationTask[]>
  verificationRun(sessionId: string): Promise<WireVerificationTask | undefined>
  reviewGet(sessionId: string): Promise<WireReview | null>
  reviewRun(sessionId: string): Promise<WireReview>
  riskGet(sessionId: string): Promise<WireRisk | null>
  riskAnalyze(sessionId: string): Promise<WireRisk>
  history(sessionId: string): Promise<WireHistoryEvent[]>
  timeline(sessionId: string): Promise<{ events: WireHistoryEvent[] }>
  policies(): Promise<WirePolicy[]>
  policySave(policy: WirePolicy): Promise<WirePolicy[]>
  policyDelete(id: string): Promise<WirePolicy[]>
  fixList(sessionId: string): Promise<WireFixRequest[]>
  fixRun(sessionId: string, reviewId: string, findingId: string, changeId: string): Promise<WireFixResult>
  loopRun(sessionId: string, maxIterations?: number): Promise<{ result: { iterations: number; stopped: string } }>
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
    gitStatus: (sessionId) => getJson(`/api/change-center/sessions/${sessionId}/git`).then(body => body as GitResponse),
    gitDiff: (sessionId) => getJson(`/api/change-center/sessions/${sessionId}/git/diff`).then(body => body as GitResponse),
    gitLog: (sessionId) => getJson(`/api/change-center/sessions/${sessionId}/git/log`).then(body => body as GitResponse),
    verificationList: (sessionId) =>
      getJson(`/api/change-center/sessions/${sessionId}/verification`).then(body => (body as { tasks: WireVerificationTask[] }).tasks),
    verificationRun: (sessionId) =>
      postJson(`/api/change-center/sessions/${sessionId}/verification/run`).then(body => (body as { task: WireVerificationTask | undefined }).task),
    reviewGet: (sessionId) =>
      getJson(`/api/change-center/sessions/${sessionId}/review`).then(body => (body as { review: WireReview | null }).review),
    reviewRun: (sessionId) =>
      postJson(`/api/change-center/sessions/${sessionId}/review/run`).then(body => (body as { review: WireReview }).review),
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
    fixRun: (sessionId, reviewId, findingId, changeId) =>
      postJson(`/api/change-center/sessions/${sessionId}/fix/run`, { reviewId, findingId, changeId }).then(body => (body as { result: WireFixResult }).result),
    loopRun: (sessionId, maxIterations) =>
      postJson(`/api/change-center/sessions/${sessionId}/loop/run`, { maxIterations }).then(body => body as { result: { iterations: number; stopped: string } }),
  }
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

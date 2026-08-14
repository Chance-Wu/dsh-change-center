/**
 * Phase-4 domain models: policies and AI auto-fix.
 * @module dsh-change-center/models
 */

/** Policy action applied when a condition set matches. */
export type PolicyAction = 'allow' | 'warn' | 'deny'

/** Condition subject a policy evaluates. */
export type PolicyConditionType = 'file' | 'operation' | 'risk' | 'language' | 'command'

/** Comparison operator for a policy condition. */
export type PolicyOperator = 'equals' | 'contains' | 'matches' | 'greater_than'

/** One condition of a change policy. */
export interface PolicyCondition {
  type: PolicyConditionType
  operator: PolicyOperator
  value: unknown
}

/** A change policy: which conditions gate which action. */
export interface ChangePolicy {
  id: string
  name: string
  enabled: boolean
  priority: number
  conditions: PolicyCondition[]
  action: PolicyAction
}

/** One policy match against a change session. */
export interface PolicyEvaluation {
  policyId: string
  action: PolicyAction
  reason: string
}

/** Lifecycle of one AI fix request. */
export type FixStatus = 'pending' | 'running' | 'completed' | 'failed'

/** An AI auto-fix request against one review finding. */
export interface FixRequest {
  id: string
  reviewId: string
  findingId: string
  sessionId: string
  changeId: string
  status: FixStatus
  instruction: string
  resultSummary?: string
  createdAt: number
  updatedAt: number
}

/** Result of an AI fix: the change(s) it produced. */
export interface FixResult {
  fixRequestId: string
  changeIds: string[]
  summary: string
}

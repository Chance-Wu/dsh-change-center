/**
 * Phase-3 domain models: git, verification, AI review, risk, and change
 * history/timeline.
 * @module dsh-change-center/models
 */

/** Repository facts reported by the git service. */
export interface GitInfo {
  root: string
  branch: string
  head: string
  dirty: boolean
}

/** A git working-tree status entry. */
export interface GitStatusEntry {
  /** Short status code, e.g. 'M' (modified), 'A' (added), 'D' (deleted). */
  code: string
  path: string
}

/** Verification task kinds. */
export type VerificationType = 'test' | 'lint' | 'typecheck' | 'build' | 'format'

/** Lifecycle status of a verification task. */
export type VerificationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'cancelled'

/** One command-based verification run against a session's workspace. */
export interface VerificationTask {
  id: string
  sessionId: string
  type: VerificationType
  command: string
  status: VerificationStatus
  exitCode?: number
  output?: string
  startedAt?: number
  finishedAt?: number
}

/** Severity of one AI-review finding. */
export type FindingSeverity = 'info' | 'warning' | 'error' | 'critical'

/** One structured finding from an AI code review. */
export interface ReviewFinding {
  id: string
  severity: FindingSeverity
  filePath: string
  line?: number
  title: string
  description: string
  suggestion?: string
}

/** Risk level shared by review and risk engines. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

/** Structured AI review of a change session. */
export interface ReviewResult {
  sessionId: string
  summary: string
  risk: RiskLevel
  score: number
  findings: ReviewFinding[]
}

/** One reason contributing to a change's risk level. */
export interface RiskReason {
  rule: string
  level: RiskLevel
  detail: string
}

/** Aggregated risk for a change session. */
export interface ChangeRisk {
  level: RiskLevel
  score: number
  reasons: RiskReason[]
}

/** Kinds of timeline/history events. */
export type ChangeEventType =
  | 'created'
  | 'reviewed'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'verified'
  | 'rolled_back'
  | 'committed'

/** Actor that produced a change event. */
export type ChangeEventActor = 'agent' | 'user' | 'system'

/** One recorded step in a change session's lifecycle. */
export interface ChangeEvent {
  id: string
  sessionId: string
  changeId?: string
  type: ChangeEventType
  actor: ChangeEventActor
  timestamp: number
  metadata?: Record<string, unknown>
}

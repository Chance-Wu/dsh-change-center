/**
 * Risk engine: deterministic rules over a session's changes, optionally
 * overridden by the AI review's risk level.
 *
 * Rules are explicit and testable (no model dependence); the AI review
 * result, when present, participates via `max(ruleLevel, aiLevel)`.
 * @module dsh-change-center/risk
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ChangeRisk, RiskLevel, RiskReason } from '../models/Phase3.ts'
import type { ChangeService } from '../services/ChangeService.ts'
import type { AIReviewService } from '../review/AIReviewService.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    risk: RiskService
  }
}

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/** Deterministic risk rules: path/deletion heuristics. */
const HIGH_DELETION_LINES = 500
const HIGH_PATH_PATTERNS = [
  /securityconfig/i,
  /permission/i,
  /authorization/i,
  /role/i,
  /\.sql$/i,
]
const MEDIUM_PATH_PATTERNS = [
  /pom\.xml$/,
  /package\.json$/,
  /build\.gradle(\.kts)?$/,
  /application\.ya?ml$/,
  /application\.properties$/,
]

/** Aggregated risk per change session. */
export class RiskService extends Service {
  static inject = ['changeCenter']

  private readonly risks = new Map<string, ChangeRisk>()

  constructor(ctx: Context) {
    super(ctx, 'risk')
  }

  /** The stored risk for a session, if one exists. */
  get(sessionId: string): ChangeRisk | undefined {
    return this.risks.get(sessionId)
  }

  /**
   * Compute the risk for a session's changes.
   * @param sessionId - the change session id.
   * @param changes - the change service (to read the session's changes).
   * @param review - optional AI review result to fold in.
   */
  analyze(sessionId: string, changes: ChangeService, review?: ReturnType<AIReviewService['get']>): ChangeRisk {
    const sessionChanges = changes.listBySession(sessionId)
    const reasons: RiskReason[] = []
    let level: RiskLevel = 'low'
    let score = 100

    const raise = (candidate: RiskLevel, reason: RiskReason): void => {
      reasons.push(reason)
      if (LEVEL_ORDER[candidate] > LEVEL_ORDER[level]) level = candidate
      score = Math.min(score, 100 - LEVEL_ORDER[candidate] * 20)
    }

    for (const change of sessionChanges) {
      // Deleted file.
      if (change.operation === 'delete') {
        raise('high', { rule: 'delete-file', level: 'high', detail: `${change.path} is deleted` })
      }
      // Large deletion (hunk line count from the diff).
      const deletions = countDeletions(change.diff)
      if (deletions > HIGH_DELETION_LINES) {
        raise('high', { rule: 'large-deletion', level: 'high', detail: `${change.path} deletes ${deletions} lines` })
      }
      // Sensitive path patterns.
      if (HIGH_PATH_PATTERNS.some(pattern => pattern.test(change.path))) {
        raise('high', { rule: 'sensitive-path', level: 'high', detail: `${change.path} matches a sensitive pattern` })
      } else if (MEDIUM_PATH_PATTERNS.some(pattern => pattern.test(change.path))) {
        raise('medium', { rule: 'config-path', level: 'medium', detail: `${change.path} is a configuration/dependency file` })
      }
    }

    // Fold in the AI review level: max(rule, ai).
    if (review !== undefined) {
      raise(review.risk, {
        rule: 'ai-review',
        level: review.risk,
        detail: review.summary || 'AI review risk',
      })
    }

    const result: ChangeRisk = { level, score: Math.max(0, score), reasons }
    this.risks.set(sessionId, result)
    return result
  }
}

/** Count `-` prefixed (deletion) lines in a unified diff. */
export function countDeletions(diff: string): number {
  let count = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('-') && !line.startsWith('--')) count++
  }
  return count
}

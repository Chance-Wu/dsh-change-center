/**
 * Review → Fix → Verify loop: iteratively AI-review a session, auto-fix its
 * error/critical findings, and re-review, up to a bounded iteration count.
 *
 * The loop never blocks apply permanently — it only produces improved pending
 * changes. When the iteration limit is reached it emits `loop:limit-reached`
 * and hands control back to the user.
 * @module dsh-change-center/loop
 */

import { resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ReviewFinding, ReviewResult } from '../models/Phase3.ts'
import type { ChangeService } from '../services/ChangeService.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fixLoop: ReviewFixLoopService
  }
}

/** Default cap on automatic review-fix iterations. */
export const DEFAULT_MAX_ITERATIONS = 3

/** Outcome of one loop run. */
export interface LoopResult {
  iterations: number
  finalReview: ReviewResult
  fixedChangeIds: string[]
  stopped: 'pass' | 'limit-reached' | 'no-fixable-findings'
}

/** Drives the review-fix-verify loop for one session. */
export class ReviewFixLoopService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fixLoop')
  }

  /**
   * Run the loop: review, fix error/critical findings, re-review.
   * @param sessionId - the change session id.
   * @param workspace - workspace path (for review context).
   * @param maxIterations - hard cap on fix rounds.
   */
  async run(sessionId: string, workspace: string, maxIterations = DEFAULT_MAX_ITERATIONS): Promise<LoopResult> {
    const sessions = this.ctx.get('changeSessions')
    const changes = this.ctx.get('changeCenter')
    const aiReview = this.ctx.get('aiReview')
    const aiFix = this.ctx.get('aiFix')
    if (sessions === undefined || changes === undefined || aiReview === undefined || aiFix === undefined) {
      throw new Error('fix-loop: required services unavailable')
    }
    const fixedChangeIds: string[] = []
    let iterations = 0
    let review = await aiReview.review(sessionId, sessions, workspace)
    let fixable = this.fixableFindings(review)

    while (fixable.length > 0 && iterations < maxIterations) {
      iterations++
      for (const finding of fixable) {
        const change = this.findChangeForFinding(sessionId, finding, changes)
        if (change === undefined || change.kind !== 'file') continue
        const result = await aiFix.fix(review.sessionId, finding, change, changes)
        fixedChangeIds.push(...result.changeIds)
      }
      review = await aiReview.review(sessionId, sessions, workspace)
      fixable = this.fixableFindings(review)
    }

    const stopped = fixable.length === 0
      ? 'pass'
      : iterations >= maxIterations
        ? 'limit-reached'
        : 'no-fixable-findings'
    if (stopped === 'limit-reached') {
      this.ctx.emit('loop:limit-reached', { sessionId, iterations })
    }
    return { iterations, finalReview: review, fixedChangeIds, stopped }
  }

  /** Error/critical findings are the auto-fix targets. */
  private fixableFindings(review: ReviewResult): ReviewFinding[] {
    return review.findings.filter(finding => finding.severity === 'error' || finding.severity === 'critical')
  }

  /**
   * Find the file change whose path matches a finding's file path. Matches
   * exact paths, suffix matches, and paths resolved against the change's
   * workspace, so relative finding paths (repo-root based) hit the right
   * change regardless of how the tool reported the path.
   */
  private findChangeForFinding(sessionId: string, finding: ReviewFinding, changes: ChangeService) {
    if (finding.filePath.length === 0) return undefined
    return changes.listBySession(sessionId)
      .find(change => changePathMatches(change, finding.filePath))
  }
}

/** Whether a change's path matches a finding path (exact / suffix / resolved). */
function changePathMatches(change: { path: string; cwd: string }, findingPath: string): boolean {
  if (change.path === findingPath) return true
  if (change.path.endsWith(`/${findingPath}`) || change.path.endsWith(`\\${findingPath}`)) return true
  if (change.cwd.length === 0) return false
  try {
    const base = resolve(change.cwd)
    const resolvedFinding = resolve(base, findingPath)
    const resolvedChange = resolve(base, change.path)
    return resolvedFinding === resolvedChange
  } catch {
    return false
  }
}

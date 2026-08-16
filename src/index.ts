/**
 * dsh-change-center — file-change capture, diff, review, and lifecycle
 * center for DeepSeek Harness.
 *
 * Host half: composes the change services, tool capture, HTTP API, and the
 * phase-3 intelligence stack (git, verification, AI review, risk, history). The plugin is deliberately thin — composition and lifecycle
 * only; every behavior lives in the services it mounts.
 *
 * The browser half (`./client`) contributes the review surface to the web UI
 * through the `settings.section` slot.
 * @module dsh-change-center
 */

import type { Context } from '@deepseek-ai/cordis'
import { ChangeService } from './services/ChangeService.ts'
import { SessionService } from './services/SessionService.ts'
import { ApplyService } from './services/ApplyService.ts'
import { SnapshotService } from './services/SnapshotService.ts'
import { JobService } from './services/JobService.ts'
import { GitService } from './git/GitService.ts'
import { VerificationService } from './verification/VerificationService.ts'
import { AIReviewService } from './review/AIReviewService.ts'
import { RiskService } from './risk/RiskService.ts'
import { HistoryService } from './history/HistoryService.ts'
import { PolicyService } from './policy/PolicyService.ts'
import { AIFixService } from './fix/AIFixService.ts'
import { ReviewFixLoopService } from './loop/ReviewFixLoopService.ts'
import { applyCapture } from './capture/ToolCapture.ts'
import { applyRoutes } from './api/routes.ts'
import type { FileChange } from './models/FileChange.ts'
import type { ChangeSession } from './models/ChangeSession.ts'
import type { ReviewResult, VerificationTask, ChangeRisk, ChangeEvent } from './models/Phase3.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A new file change was captured (Vibe Flow unified event model). */
    'change.created'(change: FileChange): void
    /** A captured change's status changed (approved / rejected / applied / failed / rolled_back). */
    'change.updated'(change: FileChange, error?: string): void
    /** A change session was created. */
    'session.created'(session: ChangeSession): void
    /** A change session's status changed (still active). */
    'session.updated'(session: ChangeSession): void
    /** A change session reached a terminal status (completed / failed / cancelled). */
    'session.completed'(session: ChangeSession): void
    /** An AI review completed for a session. */
    'review.completed'(review: ReviewResult): void
    /** A verification task finished. */
    'verification:completed'(task: VerificationTask): void
    /** A change history event was recorded. */
    'history:recorded'(event: ChangeEvent): void
    /** The review-fix loop hit its iteration limit. */
    'loop:limit-reached'(payload: { sessionId: string; iterations: number }): void
  }
}

export type * from './models/FileChange.ts'
export type * from './models/ChangeSession.ts'
export type * from './models/Phase3.ts'
export type * from './models/Phase4.ts'
export type { NewFileChange, ChangeService, RollbackAllResult, ActionError } from './services/ChangeService.ts'
export type { SessionService } from './services/SessionService.ts'
export type { ApplyService, ApplyResult } from './services/ApplyService.ts'
export type { SnapshotService, RollbackResult } from './services/SnapshotService.ts'
export type { JobService, Job, JobStatus } from './services/JobService.ts'
export type { GitService } from './git/GitService.ts'
export type { VerificationService } from './verification/VerificationService.ts'
export type { AIReviewService } from './review/AIReviewService.ts'
export type { RiskService } from './risk/RiskService.ts'
export type { HistoryService } from './history/HistoryService.ts'
export type { PolicyService } from './policy/PolicyService.ts'
export type { AIFixService } from './fix/AIFixService.ts'
export type { ReviewFixLoopService, LoopResult } from './loop/ReviewFixLoopService.ts'

/** Plugin identity used by the Cordis loader. */
export const name = 'change-center'

/** Compose the change center into the host. */
export function apply(ctx: Context): void {
  // Core services first: capture, apply, and routes share these instances.
  ctx.plugin(ChangeService)
  ctx.plugin(SessionService)
  ctx.plugin(ApplyService)
  ctx.plugin(SnapshotService)
  ctx.plugin(JobService)

  // Phase-3 intelligence services.
  ctx.plugin(GitService)
  ctx.plugin(VerificationService)
  ctx.plugin(AIReviewService)
  ctx.plugin(RiskService)
  ctx.plugin(HistoryService)

  // Phase-4 control-plane services.
  ctx.plugin(PolicyService)
  ctx.plugin(AIFixService)
  ctx.plugin(ReviewFixLoopService)

  // Then the behaviors that consume the services. Routes mount only when a
  // web server is present (web profile); capture works in every profile.
  applyCapture(ctx)
  applyRoutes(ctx)
}

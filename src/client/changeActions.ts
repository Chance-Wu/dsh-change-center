/**
 * Single source of truth for per-change action availability, derived from the
 * host state machine (ChangeService TRANSITIONS). Every entry point —
 * ReviewBar, ChangeTree quick actions — consumes this matrix so buttons stay
 * consistent across the surface.
 * @module dsh-change-center/client
 */

import type { ChangeStatus } from '../models/FileChange.ts'

/** Which actions are available for a change in a given status. */
export interface ChangeActions {
  canApprove: boolean
  canReject: boolean
  canApply: boolean
  canRetryApply: boolean
  canRollback: boolean
  /** rejected / rolled_back → pending (重新处理). */
  canRepend: boolean
}

/**
 * Actions allowed per status, mirroring the host TRANSITIONS:
 * - approve: pending
 * - reject: pending | approved | failed
 * - apply: pending | approved
 * - retryApply: failed
 * - rollback: applied
 * - repend: rejected | rolled_back
 */
export function actionsFor(status: ChangeStatus): ChangeActions {
  switch (status) {
    case 'pending':
      return { canApprove: true, canReject: true, canApply: true, canRetryApply: false, canRollback: false, canRepend: false }
    case 'approved':
      return { canApprove: false, canReject: true, canApply: true, canRetryApply: false, canRollback: false, canRepend: false }
    case 'failed':
      return { canApprove: false, canReject: true, canApply: false, canRetryApply: true, canRollback: false, canRepend: false }
    case 'applied':
      return { canApprove: false, canReject: false, canApply: false, canRetryApply: false, canRollback: true, canRepend: false }
    case 'rejected':
      return { canApprove: false, canReject: false, canApply: false, canRetryApply: false, canRollback: false, canRepend: true }
    case 'rolled_back':
      return { canApprove: false, canReject: false, canApply: false, canRetryApply: false, canRollback: false, canRepend: true }
  }
}

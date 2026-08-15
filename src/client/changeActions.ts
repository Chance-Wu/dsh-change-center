/**
 * Single source of truth for per-change action availability, derived from the
 * shared state model (models/ChangeState.ts CHANGE_ACTIONS). Every entry
 * point — ReviewBar, ChangeTree quick actions — consumes this matrix so
 * buttons stay consistent across the surface. The UI never decides legality
 * on its own (3.x 状态机收敛).
 * @module dsh-change-center/client
 */

import { CHANGE_ACTIONS } from '../models/ChangeState.ts'
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
 * Actions allowed per status, from the shared CHANGE_ACTIONS table:
 * - approve: pending
 * - reject: pending | approved | failed
 * - apply: pending | approved
 * - retryApply: failed
 * - rollback: applied
 * - repend: rejected | rolled_back
 */
export function actionsFor(status: ChangeStatus): ChangeActions {
  const actions = CHANGE_ACTIONS[status]
  return {
    canApprove: actions.includes('approve'),
    canReject: actions.includes('reject'),
    canApply: actions.includes('apply'),
    canRetryApply: actions.includes('retry-apply'),
    canRollback: actions.includes('rollback'),
    canRepend: actions.includes('repend'),
  }
}

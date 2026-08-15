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
  canApply: boolean
  canRetryApply: boolean
  canRollback: boolean
  /** rolled_back → 重新应用(替代旧 repend 中间态). */
  canReapply: boolean
}

/**
 * Actions allowed per status, from the shared CHANGE_ACTIONS table
 * (4 状态 · 应用↔回滚):
 * - apply: pending
 * - retryApply: failed
 * - rollback: applied
 * - reapply: rolled_back
 */
export function actionsFor(status: ChangeStatus): ChangeActions {
  const actions = CHANGE_ACTIONS[status]
  return {
    canApply: status === 'pending' && actions.includes('apply'),
    canRetryApply: status === 'failed' && actions.includes('retry-apply'),
    canRollback: status === 'applied' && actions.includes('rollback'),
    canReapply: status === 'rolled_back' && actions.includes('apply'),
  }
}

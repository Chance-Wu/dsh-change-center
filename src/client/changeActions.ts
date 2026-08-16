/**
 * Single source of truth for per-change action availability, derived from the
 * shared state model (models/ChangeState.ts CHANGE_ACTIONS). Every entry
 * point — ReviewBar, ChangeTree quick actions — consumes this matrix so
 * buttons stay consistent across the surface. The UI never decides legality
 * on its own (3.x 状态机收敛).
 *
 * 5.x:capture 即登记(applied),无「应用」操作 —— 只剩 回滚(applied) 与
 * 恢复(rolled_back → 写回 agent 版本)。pending/failed 为历史状态,无操作。
 * @module dsh-change-center/client
 */

import { CHANGE_ACTIONS } from '../models/ChangeState.ts'
import type { ChangeStatus } from '../models/FileChange.ts'

/** Which actions are available for a change in a given status. */
export interface ChangeActions {
  /** applied → 回滚(恢复 before 快照)。 */
  canRollback: boolean
  /** rolled_back → 恢复(写回 agent 版本,撤销回滚)。 */
  canReapply: boolean
}

/**
 * Actions allowed per status, from the shared CHANGE_ACTIONS table:
 * - rollback: applied
 * - reapply(恢复): rolled_back
 */
export function actionsFor(status: ChangeStatus): ChangeActions {
  const actions = CHANGE_ACTIONS[status]
  return {
    canRollback: status === 'applied' && actions.includes('rollback'),
    canReapply: status === 'rolled_back' && actions.includes('apply'),
  }
}

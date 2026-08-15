/**
 * The single source of truth for the change state machine (3.x: 状态机收敛).
 *
 * Every surface derives from this one definition — the host transition
 * table (`ChangeService`), the client action matrix (`actionsFor`), and the
 * presentation metadata (`statusMeta`). No component may infer on its own
 * which button or transition is legal.
 * @module dsh-change-center/models
 */

import type { ChangeStatus } from './FileChange.ts'

/** User-facing actions the state machine exposes to the UI/API. */
export type ChangeAction =
  | 'apply'
  | 'retry-apply'
  | 'rollback'

/**
 * Machine truth: legal target statuses per status. The host enforces these;
 * `failed` covers apply-attempt failures. Only two operations remain:
 * 应用(pending/failed/rolled_back → applied)与 回滚(applied → rolled_back)。
 */
export const CHANGE_TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  pending: ['applied', 'failed'],
  // failed → failed 幂等:重试应用时引擎再次失败会走到同一分支,重复转移
  // 不应抛「非法转移」,而是返回引擎结果(如仍冲突)。
  failed: ['applied', 'failed'],
  applied: ['rolled_back'],
  // 回滚后可再次应用(替代旧 repend 中间态)。
  rolled_back: ['applied'],
}

/**
 * User surface: which actions are offered per status. `actionsFor` maps this
 * to the button matrix; the review bar, the tree quick actions, and any
 * future entry point all consume it — the UI never decides action legality.
 */
export const CHANGE_ACTIONS: Record<ChangeStatus, ChangeAction[]> = {
  pending: ['apply'],
  failed: ['retry-apply'],
  applied: ['rollback'],
  // 回滚后主操作即「重新应用」。
  rolled_back: ['apply'],
}

/** Whether a transition from `from` to `to` is legal per the machine. */
export function canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  return CHANGE_TRANSITIONS[from].includes(to)
}

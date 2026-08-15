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
  | 'approve'
  | 'reject'
  | 'apply'
  | 'retry-apply'
  | 'rollback'
  | 'repend'

/**
 * Machine truth: legal target statuses per status. The host enforces these;
 * `failed` covers apply-attempt failures from any reviewable state.
 */
export const CHANGE_TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  pending: ['approved', 'rejected', 'applied', 'failed'],
  approved: ['applied', 'rejected', 'pending', 'failed'],
  rejected: ['pending'],
  applied: ['pending', 'rolled_back'],
  // failed → failed 幂等:重试应用时引擎再次失败会走到同一分支,重复转移
  // 不应抛「非法转移」,而是返回引擎结果(如仍冲突)。
  failed: ['pending', 'applied', 'approved', 'rejected', 'failed'],
  rolled_back: ['pending'],
}

/**
 * User surface: which actions are offered per status. `actionsFor` maps this
 * to the button matrix; the review bar, the tree quick actions, and any
 * future entry point all consume it — the UI never decides action legality.
 */
export const CHANGE_ACTIONS: Record<ChangeStatus, ChangeAction[]> = {
  pending: ['approve', 'reject', 'apply'],
  approved: ['reject', 'apply'],
  // failed 不显示「接受」:批量中失败的变更已被接受。
  failed: ['reject', 'retry-apply'],
  applied: ['rollback'],
  rejected: ['repend'],
  rolled_back: ['repend'],
}

/** Whether a transition from `from` to `to` is legal per the machine. */
export function canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  return CHANGE_TRANSITIONS[from].includes(to)
}

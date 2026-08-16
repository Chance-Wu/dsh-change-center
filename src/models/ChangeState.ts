/**
 * The single source of truth for the change state machine.
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
  | 'rollback'

/**
 * Machine truth: legal target statuses per status.
 *
 * 5.x 流程收敛:capture 即登记 —— agent 工具写盘后记录直接标记 `applied`,
 * 不存在「确认登记型」的应用;状态机只有 回滚(applied→rolled_back) 与
 * 恢复(rolled_back→applied) 两个写盘操作。`pending`/`failed` 是历史状态
 * (旧版本记录兼容展示),不再产生、无合法转移。
 */
export const CHANGE_TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  pending: [],
  failed: [],
  applied: ['rolled_back'],
  // 回滚后可恢复(写回 agent 版本,即撤销回滚)。
  rolled_back: ['applied'],
}

/**
 * User surface: which actions are offered per status. `actionsFor` maps this
 * to the button matrix; the review bar, the tree quick actions, and any
 * future entry point all consume it — the UI never decides action legality.
 */
export const CHANGE_ACTIONS: Record<ChangeStatus, ChangeAction[]> = {
  pending: [],
  failed: [],
  applied: ['rollback'],
  // 回滚后主操作即「恢复」(写回 agent 版本)。
  rolled_back: ['apply'],
}

/** Whether a transition from `from` to `to` is legal per the machine. */
export function canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  return CHANGE_TRANSITIONS[from].includes(to)
}

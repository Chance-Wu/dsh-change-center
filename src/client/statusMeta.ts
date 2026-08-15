/**
 * Status display metadata (3.x 状态语义,对齐 `models/ChangeState.ts`).
 *
 * The host state machine keeps six statuses; the UI collapses them into a
 * single icon + label + visual weight so `applied` reads as the main success
 * state, `failed` stands out, and `rejected`/`rolled_back` recede. Status is
 * not decoration — it hints the user's next action. Presentation only.
 * @module dsh-change-center/client
 */

import type { ChangeStatus } from '../models/FileChange.ts'

/** How strongly a status should be emphasized in the UI. */
export type StatusWeight = 'high' | 'normal' | 'low'

/** Display metadata for one change status. */
export interface StatusMeta {
  icon: string
  label: string
  weight: StatusWeight
}

/**
 * Status → icon/label/weight table(4 状态,应用↔回滚):
 * pending ○待处理 · applied ✓已应用 · failed !应用失败 · rolled_back ↶已回滚.
 */
export function statusMeta(status: ChangeStatus): StatusMeta {
  switch (status) {
    case 'pending':
      return { icon: '○', label: '待处理', weight: 'normal' }
    case 'applied':
      return { icon: '✓', label: '已应用', weight: 'high' }
    case 'rolled_back':
      return { icon: '↶', label: '已回滚', weight: 'low' }
    case 'failed':
      return { icon: '!', label: '应用失败', weight: 'high' }
  }
}

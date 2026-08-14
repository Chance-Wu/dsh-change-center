/**
 * Review bar: per-change review actions (approve / reject / apply / rollback)
 * with external-modification conflict handling. 对齐 Harness 设计 token。
 * @module dsh-change-center/client
 */

import { createElement, useState, type ReactElement } from 'react'
import type { ActionResult, ChangeCenterApi, WireChange } from './index.ts'
import { STATUS_ZH } from './i18n.ts'
import baseCss from './styles.module.css'
import css from './ReviewBar.module.css'

/** Props for the review bar. */
export interface ReviewBarProps {
  change: WireChange
  api: ChangeCenterApi
  onAction: () => void
  onError: (message: string) => void
  /** External disable (e.g. a session-level bulk operation is in flight). */
  disabled?: boolean
}

/** 状态 → 徽标样式类（共用）。 */
function statusClass(status: string): string {
  switch (status) {
    case 'approved': return baseCss.badgeSuccess
    case 'rejected': return baseCss.badgeError
    case 'failed': return baseCss.badgeError
    case 'applied': return baseCss.badgeBusiness
    case 'rolled_back': return baseCss.badge
    default: return baseCss.badgeWarn
  }
}

/** Per-change review controls. */
export function ReviewBar(props: ReviewBarProps): ReactElement {
  const { change, api, onAction, onError, disabled = false } = props
  const [conflict, setConflict] = useState<ActionResult | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<unknown>, allowConflict = false): Promise<void> => {
    setBusy(true)
    setConflict(null)
    try {
      const result = (await action()) as ActionResult
      if (result.kind === 'conflict' || (result as { error?: string }).error === 'external modification detected') {
        setConflict(result)
      } else {
        onAction()
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  // 按钮按状态机合法转移显示:接受(pending/failed)、拒绝(pending/approved/failed)、
  // 应用(pending/approved)、重试应用(failed)、回滚(applied)。
  const status = change.status
  const canApprove = status === 'pending' || status === 'failed'
  const canReject = status === 'pending' || status === 'approved' || status === 'failed'
  const inert = busy || disabled

  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    createElement('div', { className: css.bar },
      createElement('div', { className: css.left },
        createElement('span', { className: statusClass(status) }, STATUS_ZH[status] ?? status),
        createElement('span', { className: css.toolMeta }, `通过 ${change.toolName}`),
      ),
      createElement('div', { className: css.actions },
        canReject
          ? createElement('button', {
            onClick: () => run(() => api.changeAction(change.id, 'reject')),
            disabled: inert,
            className: baseCss.buttonDanger,
          }, '拒绝')
          : null,
        canApprove
          ? createElement('button', {
            onClick: () => run(() => api.changeAction(change.id, 'approve')),
            disabled: inert,
            className: baseCss.buttonPrimary,
          }, '接受')
          : null,
        status === 'applied'
          ? createElement('button', {
            onClick: () => run(() => api.changeAction(change.id, 'rollback')),
            disabled: inert,
            className: baseCss.buttonGhost,
          }, '回滚')
          : status === 'pending' || status === 'approved'
            ? createElement('button', {
              onClick: () => run(() => api.applyChange(change.id)),
              disabled: inert,
              className: baseCss.buttonPrimary,
            }, '应用')
            : status === 'failed'
              ? createElement('button', {
                onClick: () => run(() => api.applyChange(change.id)),
                disabled: inert,
                className: baseCss.buttonPrimary,
              }, '重试应用')
              : null,
      ),
    ),
    conflict !== null
      ? createElement('div', { className: css.conflict },
        createElement('div', { className: css.conflictTitle }, '⚠ 文件已被外部修改'),
        createElement('div', { className: css.conflictDesc },
          '当前工作区文件与捕获时的版本不一致，直接应用会覆盖外部修改。'),
        createElement('div', { className: css.conflictActions },
          createElement('button', {
            onClick: () => { setConflict(null); onAction() },
            className: baseCss.buttonGhost,
          }, '重新加载'),
          createElement('button', {
            onClick: () => run(() => api.applyChange(change.id, true)),
            className: baseCss.buttonPrimary,
          }, '强制应用'),
        ),
      )
      : null,
  )
}

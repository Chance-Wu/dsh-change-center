/**
 * Review bar: per-change review actions (approve / reject / apply / rollback)
 * with external-modification conflict handling. 对齐 Harness 设计 token。
 * @module dsh-change-center/client
 */

import { createElement, useState, type ReactElement } from 'react'
import type { ActionResult, ChangeCenterApi, WireChange } from './index.ts'
import { actionsFor } from './changeActions.ts'
import { statusMeta } from './statusMeta.ts'
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

/** 状态 → 徽标样式类（共用;权重按 V-8:applied=成功主态、failed=突出、rejected/rolled_back=弱化）。 */
function statusClass(status: string): string {
  switch (status) {
    case 'pending': return baseCss.badgeWarn
    case 'approved': return baseCss.badgeBusiness
    case 'applied': return baseCss.badgeSuccess
    case 'rejected': return baseCss.badgeError
    case 'rolled_back': return baseCss.badge
    case 'failed': return baseCss.badgeError
    default: return baseCss.badge
  }
}

/** Per-change review controls. */
export function ReviewBar(props: ReviewBarProps): ReactElement {
  const { change, api, onAction, onError, disabled = false } = props
  const [conflict, setConflict] = useState<ActionResult | null>(null)
  // 3.3:策略 deny 是真正的 Guard —— 给「仍然应用(force)」路径。
  const [deny, setDeny] = useState<{ message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<unknown>, allowConflict = false): Promise<void> => {
    setBusy(true)
    setConflict(null)
    setDeny(null)
    try {
      const result = (await action()) as ActionResult
      const message = (result as { message?: string }).message ?? ''
      if (result.kind === 'conflict' || (result as { error?: string }).error === 'external modification detected') {
        setConflict(result)
      } else if (result.kind === 'error' && message.startsWith('policy deny')) {
        // 3.3:策略拦截 —— 变更保持 pending,提供「仍然应用」。
        setDeny({ message })
      } else if (result.kind === 'missing-snapshot') {
        onError('回滚失败：快照不存在（文件保持当前状态）')
      } else if (result.kind === 'error') {
        // 结构化错误(如非法转移):显式提示,不静默。
        onError(message || '操作失败')
      } else {
        onAction()
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  // 按钮矩阵来自单一事实源 actionsFor(与状态机 TRANSITIONS 一致);
  // failed 不显示「接受」:批量中失败的变更已被接受。
  const actions = actionsFor(change.status)
  const meta = statusMeta(change.status)
  const inert = busy || disabled

  return createElement('div', { className: css.wrap },
    createElement('div', { className: css.bar },
      createElement('div', { className: css.left },
        createElement('span', { className: statusClass(change.status), title: meta.label }, `${meta.icon} ${meta.label}`),
        createElement('span', { className: css.toolMeta }, `通过 ${change.toolName}`),
      ),
      createElement('div', { className: css.actions },
        actions.canReject
          ? createElement('button', {
            onClick: () => run(() => api.changeAction(change.id, 'reject')),
            disabled: inert,
            className: baseCss.buttonDanger,
          }, '拒绝')
          : null,
        actions.canApprove
          ? createElement('button', {
            onClick: () => run(() => api.changeAction(change.id, 'approve')),
            disabled: inert,
            className: baseCss.buttonPrimary,
          }, '接受')
          : null,
        actions.canApply
          ? createElement('button', {
            onClick: () => run(() => api.applyChange(change.id)),
            disabled: inert,
            className: baseCss.buttonPrimary,
          }, '应用')
          : null,
        actions.canRetryApply
          ? createElement('button', {
            onClick: () => run(() => api.applyChange(change.id)),
            disabled: inert,
            className: baseCss.buttonPrimary,
          }, '重试应用')
          : null,
        actions.canRollback
          ? createElement('button', {
            onClick: () => run(() => api.changeAction(change.id, 'rollback')),
            disabled: inert,
            className: baseCss.buttonGhost,
          }, '回滚')
          : null,
        actions.canRepend
          ? createElement('button', {
            onClick: () => run(() => api.changeAction(change.id, 'repend')),
            disabled: inert,
            className: baseCss.buttonGhost,
          }, '重新处理')
          : null,
      ),
    ),
    conflict !== null
      ? createElement('div', { className: css.conflict },
        createElement('div', { className: css.conflictTitle }, '⚠ 文件已被外部修改'),
        createElement('div', { className: css.conflictDesc },
          '当前工作区文件与捕获时的版本不一致，直接应用会覆盖外部修改。'),
        // S-2:hash 差异一目了然(前/后/磁盘当前)。
        conflict.currentHash !== undefined && conflict.beforeHash !== undefined
          ? createElement('div', { className: css.conflictHash },
            `磁盘当前 ${conflict.currentHash.slice(0, 8)} ≠ 捕获时 ${conflict.beforeHash.slice(0, 8)}`)
          : null,
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
    // 3.3:策略 deny —— 「仍然应用(force)」需用户明确选择。
    deny !== null
      ? createElement('div', { className: css.conflict },
        createElement('div', { className: css.conflictTitle }, '⛔ 此变更被策略阻止'),
        createElement('div', { className: css.conflictDesc },
          deny.message.replace(/^policy deny:\s*/, '')),
        createElement('div', { className: css.conflictActions },
          createElement('button', {
            onClick: () => setDeny(null),
            className: baseCss.buttonGhost,
          }, '关闭'),
          createElement('button', {
            onClick: () => run(() => api.applyChange(change.id, true)),
            className: baseCss.buttonPrimary,
          }, '仍然应用'),
        ),
      )
      : null,
    // S-3:应用失败的恢复提示。
    change.status === 'failed'
      ? createElement('div', { className: css.failedHint },
        '应用失败:可「重试应用」;持续失败可拒绝该变更。')
      : null,
  )
}

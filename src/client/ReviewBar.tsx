/**
 * Review bar: per-change review actions (apply / rollback / re-pend)
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
  /** 5.x 文件导航:上一个 / 下一个变更。 */
  onPrev?: () => void
  onNext?: () => void
  /** 操作成功(应用/回滚)后的反馈钩子 —— 父级据此给 toast(应用带撤销)。 */
  onApplied?: (operation: 'apply' | 'rollback') => void
}

/** 状态 → 徽标样式类(共用;按 V-8:applied=成功主态、failed=突出、rolled_back=弱化)。 */
function statusClass(status: string): string {
  switch (status) {
    case 'pending': return baseCss.badgeWarn
    case 'applied': return baseCss.badgeSuccess
    case 'rolled_back': return baseCss.badge
    case 'failed': return baseCss.badgeError
    default: return baseCss.badge
  }
}

/** Per-change review controls. */
export function ReviewBar(props: ReviewBarProps): ReactElement {
  const { change, api, onAction, onError, disabled = false, onPrev, onNext, onApplied } = props
  const [conflict, setConflict] = useState<ActionResult | null>(null)
  // 4.6 Conflict Center:对比视图状态。
  const [viewingConflict, setViewingConflict] = useState(false)
  const [current, setCurrent] = useState<{ exists: boolean; content: string | null } | null>(null)
  const [merging, setMerging] = useState(false)
  const [mergedDraft, setMergedDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // S-3 改进:记录最近一次操作失败的具体原因,就地展示(而非只丢到面板顶部)。
  const [lastError, setLastError] = useState<string | null>(null)

  /** 打开对比视图:拉取磁盘当前版本。 */
  const openConflictView = (): void => {
    setViewingConflict(true)
    setMerging(false)
    api.changeCurrent(change.id)
      .then(setCurrent)
      .catch(() => setCurrent({ exists: false, content: null }))
  }

  const run = async (action: () => Promise<unknown>, operation?: 'apply' | 'rollback'): Promise<void> => {
    setBusy(true)
    setConflict(null)
    setViewingConflict(false)
    setLastError(null)
    try {
      const result = (await action()) as ActionResult
      const message = (result as { message?: string }).message ?? ''
      if (result.kind === 'conflict' || (result as { error?: string }).error === 'external modification detected') {
        setConflict(result)
        setLastError('外部修改冲突：磁盘内容与捕获版本不一致（可「查看差异」或「强制写入」）')
      } else if (result.kind === 'missing-snapshot') {
        onError('回滚失败：快照不存在（文件保持当前状态）')
      } else if (result.kind === 'error') {
        // 结构化错误(如非法转移):显式提示,不静默。
        setLastError(message || '操作失败')
        onError(message || '操作失败')
      } else {
        onAction()
        if (operation !== undefined) onApplied?.(operation)
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  // 按钮矩阵来自单一事实源 actionsFor(5.x:capture 即登记,只剩 回滚/恢复)。
  const actions = actionsFor(change.status)
  const meta = statusMeta(change.status)
  const inert = busy || disabled

  return createElement('div', { className: css.wrap },
    createElement('div', { className: css.bar },
      createElement('div', { className: css.left },
        onPrev !== undefined || onNext !== undefined
          ? createElement('div', { className: css.navGroup },
            createElement('button', {
              onClick: onPrev,
              disabled: inert || onPrev === undefined,
              className: css.navBtn,
              title: '上一个变更 (K)',
            }, '←'),
            createElement('button', {
              onClick: onNext,
              disabled: inert || onNext === undefined,
              className: css.navBtn,
              title: '下一个变更 (J)',
            }, '→'),
          )
          : null,
        createElement('span', { className: statusClass(change.status), title: meta.label }, `${meta.icon} ${meta.label}`),
        createElement('span', { className: css.toolMeta }, `通过 ${change.toolName}`),
      ),
      createElement('div', { className: css.actions },
        actions.canRollback
          ? createElement('button', {
            onClick: () => run(() => api.changeAction(change.id, 'rollback'), 'rollback'),
            disabled: inert,
            className: baseCss.buttonGhost,
            title: '撤销本次修改:恢复捕获前的版本,之后可「恢复」',
          }, '回滚')
          : null,
        actions.canReapply
          ? createElement('button', {
            onClick: () => run(() => api.changeAction(change.id, 'restore'), 'apply'),
            disabled: inert,
            className: baseCss.buttonPrimary,
            title: '撤销回滚:把 agent 版本写回磁盘',
          }, '恢复')
          : null,
      ),
    ),
    conflict !== null
      ? createElement('div', { className: css.conflict },
        createElement('div', { className: css.conflictTitle }, '⚠ 文件已被外部修改'),
        createElement('div', { className: css.conflictDesc },
          '当前工作区文件与捕获时的版本不一致，直接写入会覆盖外部修改。'),
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
          // 4.6 Conflict Center:对比 Agent 版本 vs 当前版本。
          createElement('button', {
            onClick: () => openConflictView(),
            className: baseCss.buttonGhost,
          }, '查看差异'),
          createElement('button', {
            onClick: () => run(() => api.editChange(change.id, change.after ?? '', true), 'apply'),
            className: baseCss.buttonPrimary,
          }, '强制写入'),
        ),
      )
      : null,
    // 4.6 Conflict Center:双栏对比 + 保留我的 / 采用Agent / 合并。
    viewingConflict && current !== null
      ? createElement('div', { className: css.conflictView },
        createElement('div', { className: css.conflictCols },
          createElement('div', { className: css.conflictCol },
            createElement('div', { className: css.conflictColTitle }, 'Agent 版本'),
            createElement('pre', { className: css.conflictCode }, change.after ?? '(删除)'),
          ),
          createElement('div', { className: css.conflictCol },
            createElement('div', { className: css.conflictColTitle }, '当前版本'),
            createElement('pre', { className: css.conflictCode }, current.content ?? '(文件不存在)'),
          ),
        ),
        merging
          ? createElement('textarea', {
            className: css.conflictMerge,
            value: mergedDraft,
            onChange: (event: { target: { value: string } }) => setMergedDraft(event.target.value),
            spellCheck: false,
          })
          : null,
        createElement('div', { className: css.conflictActions },
          merging
            ? createElement('button', {
              onClick: () => run(() => api.resolveChange(change.id, mergedDraft), 'apply'),
              className: baseCss.buttonPrimary,
            }, '应用合并')
            : createElement('button', {
              onClick: () => { setMergedDraft(change.after ?? ''); setMerging(true) },
              className: baseCss.buttonGhost,
            }, '合并'),
          createElement('button', {
            onClick: () => run(() => api.editChange(change.id, change.after ?? '', true), 'apply'),
            className: baseCss.buttonPrimary,
          }, '采用Agent'),
        ),
      )
      : null,
    // S-3:写盘失败的恢复提示(带具体原因,便于判断是冲突/权限)。
    change.status === 'failed'
      ? createElement('div', { className: css.failedHint },
        lastError !== null && lastError.length > 0
          ? `写盘失败：${lastError}。可「查看差异」后强制写入或编辑后保存。`
          : '写盘失败:可「查看差异」后强制写入,或编辑后保存。')
      : null,
  )
}

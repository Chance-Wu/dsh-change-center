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
  /** 5.x 文件导航:上一个 / 下一个变更。 */
  onPrev?: () => void
  onNext?: () => void
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
  const { change, api, onAction, onError, disabled = false, onPrev, onNext } = props
  const [conflict, setConflict] = useState<ActionResult | null>(null)
  // 3.3:策略 deny 是真正的 Guard —— 给「仍然应用(force)」路径。
  const [deny, setDeny] = useState<{ message: string } | null>(null)
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

  const run = async (action: () => Promise<unknown>, allowConflict = false): Promise<void> => {
    setBusy(true)
    setConflict(null)
    setDeny(null)
    setViewingConflict(false)
    setLastError(null)
    try {
      const result = (await action()) as ActionResult
      const message = (result as { message?: string }).message ?? ''
      if (result.kind === 'conflict' || (result as { error?: string }).error === 'external modification detected') {
        setConflict(result)
        setLastError('外部修改冲突：磁盘内容与捕获版本不一致（可「查看差异」或「强制应用」）')
      } else if (result.kind === 'error' && message.startsWith('policy deny')) {
        // 3.3:策略拦截 —— 变更保持 pending,提供「仍然应用」。
        setDeny({ message })
      } else if (result.kind === 'missing-snapshot') {
        onError('回滚失败：快照不存在（文件保持当前状态）')
      } else if (result.kind === 'error') {
        // 结构化错误(如非法转移):显式提示,不静默。
        setLastError(message || '操作失败')
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
        actions.canReject
          ? createElement('button', {
            onClick: () => run(() => api.changeAction(change.id, 'reject')),
            disabled: inert,
            className: baseCss.buttonDanger,
          }, '拒绝')
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
          // 4.6 Conflict Center:对比 Agent 版本 vs 当前版本。
          createElement('button', {
            onClick: () => openConflictView(),
            className: baseCss.buttonGhost,
          }, '查看差异'),
          createElement('button', {
            onClick: () => run(() => api.applyChange(change.id, true)),
            className: baseCss.buttonPrimary,
          }, '强制应用'),
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
          createElement('button', {
            onClick: () => {
              setViewingConflict(false)
              // 保留我的:磁盘已是用户版本,拒绝该变更即可。
              run(() => api.changeAction(change.id, 'reject'))
            },
            className: baseCss.buttonGhost,
          }, '保留我的'),
          merging
            ? createElement('button', {
              onClick: () => run(() => api.resolveChange(change.id, mergedDraft)),
              className: baseCss.buttonPrimary,
            }, '应用合并')
            : createElement('button', {
              onClick: () => { setMergedDraft(change.after ?? ''); setMerging(true) },
              className: baseCss.buttonGhost,
            }, '合并'),
          createElement('button', {
            onClick: () => run(() => api.applyChange(change.id, true)),
            className: baseCss.buttonPrimary,
          }, '采用Agent'),
        ),
      )
      : null,
    // 3.3:策略 deny —— 「仍然应用(force)」需用户明确选择。
    deny !== null
      ? createElement('div', { className: css.denyBlock },
        createElement('div', { className: css.denyTitle }, '⊘ 此变更被策略阻止'),
        createElement('div', { className: css.denyDesc },
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
    // S-3:应用失败的恢复提示(带具体原因,便于判断是冲突/权限/策略)。
    change.status === 'failed'
      ? createElement('div', { className: css.failedHint },
        lastError !== null && lastError.length > 0
          ? `应用失败：${lastError}。可「重试应用」；持续失败可拒绝该变更。`
          : '应用失败:可「重试应用」;持续失败可拒绝该变更。')
      : null,
  )
}

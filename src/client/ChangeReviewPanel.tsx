/**
 * Change review panel: the shared review surface for ONE change session —
 * file tree on the left, diff viewer + review bar in the center, and the
 * intelligence column (git/review/risk/verification/policy) behind the
 * 「··· / 更多」 fold. Used both by the settings Change Center section and the
 * conversation Changes tab.
 *
 * Vibe UI (2.1):
 * - V-1 默认第一屏 = 当前 Turn 卡片;Git/Review/Risk/Verification/History/Fix 全部收进 More。
 * - V-2 Focus(极简卡片)⇄ Review(展开审查)双模式。
 * - V-4 顶部固定 [✓ 全部应用] [拒绝];无风险一步到位 + toast Undo;有风险给
 *   「⚠ … [查看] [仍然全部应用(force)]」轻确认,不弹复杂对话框。
 * - V-5 风险只显示 ✓/⚠/⛔ 三级信号 + hover 一句话,不显示数字评分。
 * - V-7 编辑器脏状态:未保存修改时切换文件先三选(保存并切换/放弃并切换/取消),
 *   且锁定 Apply/批量,保证应用的永远是用户看到的版本。
 * - V-8 状态视觉:applied=主成功态、failed=突出、rejected/rolled_back=弱化。
 * - V-11 Issues 过滤器:全部 / 待处理 / 问题。
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useMemo, useState, type ReactElement } from 'react'
import type {
  ChangeCenterApi, WireAcceptAllResult, WireChange, WirePolicyEvaluation, WirePolicyHit, WireReview, WireRisk,
} from './index.ts'
import { ChangeTree, dedupeByPath } from './ChangeTree.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { actionsFor } from './changeActions.ts'
import { countDiff } from '../services/DiffService.ts'
import { DiffViewer } from './DiffViewer.tsx'
import { ReviewBar } from './ReviewBar.tsx'
import { IntelligencePanel } from './IntelligencePanel.tsx'
import { RiskSignal, type SignalLevel } from './RiskSignal.tsx'
import { statusMeta } from './statusMeta.ts'
import { summarizeChanges } from './summary.ts'
import baseCss from './styles.module.css'
import css from './ChangeReviewPanel.module.css'

/** Props for the review panel. */
export interface ChangeReviewPanelProps {
  /** The change session id (changeSessions entry) to review. */
  sessionId: string
  /** Display name for the session header. */
  name: string
  status: 'active' | 'completed' | 'cancelled' | 'failed'
  agentSessionId: string
  workspace: string
  statistics: { files: number; additions: number; deletions: number }
  api: ChangeCenterApi
  onChanged?: () => void
  /** V-2:初始模式。conversation 标签页默认 Focus,设置区默认 Review。 */
  defaultMode?: 'focus' | 'review'
  /** V-7:编辑器是否有未保存修改(供外层会话切换守卫)。 */
  onEditorDirtyChange?: (dirty: boolean) => void
  /** 2.3 S-8:会话自然语言摘要(host 落库);缺省时客户端启发式兜底。 */
  summary?: string
}

/** 批量结果摘要自动消失的时长（毫秒）。 */
const RESULT_AUTO_DISMISS_MS = 6000

/** Issues 过滤器三个视图。 */
export type ChangeFilter = 'all' | 'pending' | 'issues'

/** 顶部 toast(批量结果 + Undo 入口)。 */
interface Toast {
  text: string
  kind: 'ok' | 'warn' | 'error'
  /** Undo-first:应用成功后的撤销入口(= rollbackAll)。 */
  undo?: () => void
}

/** 批量应用被 冲突/策略 拦截时的轻确认块。 */
interface WarnState {
  kind: 'conflict' | 'deny'
  items: { id: string; message: string }[]
}

/**
 * A change is reviewable only if it is a real file change with an actual
 * content diff. Command/external records (a shell command the agent ran) and
 * no-op writes (before === after) are audit entries, not things to review —
 * keep them out of the review surface.
 */
export function isReviewableChange(change: WireChange): boolean {
  if (change.kind !== 'file') return false
  return change.before !== change.after
}

/** Review one change session: tree + diff + review + intelligence. */
export function ChangeReviewPanel(props: ChangeReviewPanelProps): ReactElement {
  const {
    sessionId, name, status, workspace, api, onChanged,
    defaultMode = 'review', onEditorDirtyChange, summary: persistedSummary,
  } = props
  const [changes, setChanges] = useState<WireChange[]>([])
  const [selectedChange, setSelectedChange] = useState<string | null>(null)
  const [diffMode, setDiffMode] = useState<'unified' | 'side-by-side' | 'editor'>('unified')
  const [mode, setMode] = useState<'focus' | 'review'>(defaultMode)
  const [moreOpen, setMoreOpen] = useState(false)
  const [filter, setFilter] = useState<ChangeFilter>('all')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [warnState, setWarnState] = useState<WarnState | null>(null)
  const [editorDraft, setEditorDraft] = useState<string>('')
  const [pendingSelect, setPendingSelect] = useState<string | null>(null)
  const [risk, setRisk] = useState<WireRisk | null>(null)
  const [evaluations, setEvaluations] = useState<WirePolicyEvaluation[]>([])
  const [policyHits, setPolicyHits] = useState<WirePolicyHit[]>([])
  const [review, setReview] = useState<WireReview | null>(null)

  const refresh = (): void => {
    // 单个会话的变更量通常远小于分页上限，取整页避免静默截断。
    api.sessionChanges(sessionId, { limit: 500 })
      .then(page => {
        setChanges(page.items)
        // Keep the selection when it still exists; otherwise pick the first
        // reviewable file change (command records are not selectable).
        setSelectedChange(prev => {
          if (prev !== null && page.items.some(c => c.id === prev)) return prev
          return page.items.find(isReviewableChange)?.id ?? null
        })
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  // 情报数据:风险信号与 Issues 过滤器只读这些轻量结果。
  const refreshIntelligence = (): void => {
    api.riskGet(sessionId).then(setRisk).catch(() => setRisk(null))
    api.policyEvaluation(sessionId)
      .then(({ evaluations: evs, hits }) => { setEvaluations(evs); setPolicyHits(hits) })
      .catch(() => { setEvaluations([]); setPolicyHits([]) })
    api.reviewGet(sessionId).then(setReview).catch(() => setReview(null))
  }

  useEffect(() => {
    refresh()
    refreshIntelligence()
  }, [sessionId])

  // 2.2 L-2/L-4:实时变更流 —— AI 工作中文件逐条出现、apply/reject 实时同步,
  // 多标签页共享同一 SSE 连接自动一致;事件驱动,无轮询。
  useEffect(() => {
    const unsubscribe = api.subscribeEvents(() => {
      refresh()
      refreshIntelligence()
    })
    return unsubscribe
  }, [sessionId])

  // 批量结果摘要数秒后自动消失,避免面板长时间锁定。
  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(() => setToast(null), RESULT_AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast])

  const afterAction = (): void => {
    refresh()
    refreshIntelligence()
    onChanged?.()
  }

  /** 只审查真实文件变更；同一文件的多次写入只保留最新一次（按路径去重）。 */
  const fileChanges = dedupeByPath(changes.filter(isReviewableChange))
  // 头部统计与去重后的审查面一致（store 的统计含被覆盖的旧写入）。
  const displayStats = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const c of fileChanges) {
      const counts = countDiff(c.before, c.after)
      additions += counts.additions
      deletions += counts.deletions
    }
    return { files: fileChanges.length, additions, deletions }
  }, [fileChanges])
  const change = fileChanges.find(c => c.id === selectedChange) ?? null
  const pendingCount = fileChanges.filter(c => c.status === 'pending').length
  const appliedTotal = fileChanges.filter(c => c.status === 'applied').length
  // S-8:优先 host 落库摘要(重启后仍可用);旧会话缺省时客户端启发式兜底。
  const summary = persistedSummary !== undefined && persistedSummary.length > 0
    ? persistedSummary
    : summarizeChanges(fileChanges)

  // V-5:风险 → 三级信号(deny > risk level)。
  const signal = useMemo<{ level: SignalLevel; hint: string }>(() => {
    const denial = evaluations.find(e => e.action === 'deny')
    if (denial !== undefined) return { level: 'block', hint: denial.reason }
    const level = risk?.level
    if (level === 'medium' || level === 'high' || level === 'critical') {
      return { level: 'warn', hint: risk?.reasons[0]?.detail ?? `风险等级：${level}` }
    }
    return { level: 'ok', hint: '未发现风险' }
  }, [risk, evaluations])

  // S-6:策略 deny 的变更(逐变更命中 → ⛔ 徽标 + 纳入 Issues)。
  const deniedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const hit of policyHits) {
      if (hit.action === 'deny') ids.add(hit.changeId)
    }
    return ids
  }, [policyHits])

  // V-11:Issues = 应用失败 ∪ 命中 error/critical 审查发现 ∪ 策略 deny 的变更。
  const issueIds = useMemo(() => {
    const ids = new Set<string>()
    for (const c of fileChanges) {
      if (c.status === 'failed') ids.add(c.id)
      if (deniedIds.has(c.id)) ids.add(c.id)
    }
    for (const finding of review?.findings ?? []) {
      if (finding.severity !== 'error' && finding.severity !== 'critical') continue
      for (const c of fileChanges) {
        if (findingPathMatches(c.path, finding.filePath)) ids.add(c.id)
      }
    }
    return ids
  }, [fileChanges, review, deniedIds])

  const filteredChanges = useMemo(() => {
    if (filter === 'pending') return fileChanges.filter(c => c.status === 'pending')
    if (filter === 'issues') return fileChanges.filter(c => issueIds.has(c.id))
    return fileChanges
  }, [fileChanges, filter, issueIds])

  // V-7:脏状态 = 编辑草稿 ≠ 当前版本的 after。
  const editorDirty = change !== null && editorDraft !== (change.after ?? '')
  useEffect(() => {
    onEditorDirtyChange?.(editorDirty)
  }, [editorDirty])

  // 面板锁:批量进行中 / 结果展示期间 / 编辑器有未保存修改,单条入口全部禁用。
  const panelLocked = busy || toast !== null || warnState !== null || editorDirty

  // P-3 键盘快捷键(仅高频动作;输入框/编辑器聚焦时全部短路)。
  useEffect(() => {
    if (mode !== 'review') return
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key === 'Enter') {
        event.preventDefault()
        if (change !== null && !panelLocked && actionsFor(change.status).canApply) {
          void api.applyChange(change.id).then(afterAction).catch(err => setError(err instanceof Error ? err.message : String(err)))
        }
        return
      }
      const currentIndex = change !== null ? filteredChanges.findIndex(c => c.id === change.id) : -1
      switch (event.key) {
        case 'Escape': setMode('focus'); return
        case 'ArrowDown':
        case 'j': {
          if (currentIndex >= 0 && currentIndex < filteredChanges.length - 1) {
            handleSelect(filteredChanges[currentIndex + 1]!.id)
          } else if (currentIndex < 0 && filteredChanges.length > 0) {
            handleSelect(filteredChanges[0]!.id)
          }
          return
        }
        case 'ArrowUp':
        case 'k': {
          if (currentIndex > 0) handleSelect(filteredChanges[currentIndex - 1]!.id)
          return
        }
        case 'r': setMoreOpen(true); return
        case 'a':
          if (change !== null && !panelLocked && actionsFor(change.status).canApply) {
            void api.applyChange(change.id).then(afterAction).catch(err => setError(err instanceof Error ? err.message : String(err)))
          }
          return
        case 'x':
          if (change !== null && !panelLocked && actionsFor(change.status).canReject) quickAction(change.id, 'reject')
          return
        case 'z':
          if (change !== null && !panelLocked && actionsFor(change.status).canRollback) quickAction(change.id, 'rollback')
          return
        default: return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, change, filteredChanges, panelLocked])

  /** 选择变更(经守卫:未保存修改时先三选)。 */
  const handleSelect = (id: string): void => {
    if (editorDirty && id !== change?.id) {
      setPendingSelect(id)
      return
    }
    selectChange(id)
  }

  /** 真正切换:重置编辑草稿到新变更的 after。 */
  const selectChange = (id: string): void => {
    const target = fileChanges.find(c => c.id === id)
    setSelectedChange(id)
    setEditorDraft(target?.after ?? '')
  }

  /** Tree quick actions + the review bar share one action path. */
  const quickAction = (id: string, action: 'approve' | 'reject' | 'rollback' | 'repend'): void => {
    api.changeAction(id, action)
      .then(afterAction)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  // ── V-4 批量操作 ────────────────────────────────────────────────
  const applyAll = (force = false): void => {
    setBusy(true)
    setWarnState(null)
    api.acceptAllAndApply(sessionId, force)
      .then(result => {
        afterAction()
        const conflicts = result.failed.filter(item => item.message.includes('external modification detected'))
        if (!force && result.blocked.length > 0) {
          setWarnState({ kind: 'deny', items: result.blocked })
        } else if (!force && conflicts.length > 0) {
          setWarnState({ kind: 'conflict', items: conflicts })
        } else if (result.failed.length > conflicts.length || (force && result.failed.length > 0)) {
          setToast({ text: `! ${result.failed.length} 个变更应用失败`, kind: 'error' })
        } else if (result.applied.length > 0) {
          setToast({
            text: `✓ ${result.applied.length} 个变更已应用`,
            kind: 'ok',
            undo: () => rollbackAll(),
          })
        } else {
          setToast({ text: '没有待应用的变更', kind: 'warn' })
        }
      })
      .catch(err => setToast({ text: err instanceof Error ? err.message : String(err), kind: 'error' }))
      .finally(() => setBusy(false))
  }

  const rejectAll = (): void => {
    setBusy(true)
    api.sessionAction(sessionId, 'reject-all')
      .then(result => {
        afterAction()
        setToast({ text: `× 已拒绝 ${result.updated.length} 个变更`, kind: 'ok' })
      })
      .catch(err => setToast({ text: err instanceof Error ? err.message : String(err), kind: 'error' }))
      .finally(() => setBusy(false))
  }

  const rollbackAll = (): void => {
    setBusy(true)
    api.rollbackAll(sessionId)
      .then(result => {
        afterAction()
        const parts = [`↶ 已回滚 ${result.rolledBack.length} 个变更`]
        if (result.missing.length > 0) parts.push(`缺快照 ${result.missing.length}`)
        if (result.failed.length > 0) parts.push(`失败 ${result.failed.length}`)
        setToast({ text: parts.join(' · '), kind: result.failed.length > 0 ? 'warn' : 'ok' })
      })
      .catch(err => setToast({ text: err instanceof Error ? err.message : String(err), kind: 'error' }))
      .finally(() => setBusy(false))
  }

  const saveEditor = (): void => {
    if (change === null) return
    api.editChange(change.id, editorDraft)
      .then(afterAction)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  /** 未保存修改确认:保存并切换 / 放弃并切换 / 取消。 */
  const confirmPendingSelect = (action: 'save' | 'discard' | 'cancel'): void => {
    const target = pendingSelect
    if (target === null) return
    if (action === 'cancel') {
      setPendingSelect(null)
      return
    }
    if (action === 'save' && change !== null) {
      api.editChange(change.id, editorDraft)
        .then(() => {
          afterAction()
          selectChange(target)
          setPendingSelect(null)
        })
        .catch(err => setError(err instanceof Error ? err.message : String(err)))
      return
    }
    // discard:放弃当前草稿并切换。
    selectChange(target)
    setPendingSelect(null)
  }

  const locator = (id: string): void => {
    setMode('review')
    setSelectedChange(id)
    const target = fileChanges.find(c => c.id === id)
    setEditorDraft(target?.after ?? '')
  }

  // ── Focus 模式(V-2):极小卡片 ─────────────────────────────────────
  if (mode === 'focus') {
    return createElement(ErrorBoundary, null,
      createElement('div', { className: css.panel },
        error !== null ? createElement('p', { className: css.error }, error) : null,
        createElement('div', { className: css.focusCard },
          createElement('div', { className: css.focusHead },
            createElement('span', { className: css.focusTitle }, name),
            createElement('span', { className: sessionStatusClass(status, baseCss, css) }, sessionStatusZh(status)),
            createElement(RiskSignal, { level: signal.level, hint: signal.hint }),
          ),
          createElement('div', { className: css.focusSummary }, summary),
          createElement('div', { className: css.focusStats },
            status === 'active'
              ? createElement('span', { className: css.focusWorking }, '● AI 工作中')
              : null,
            createElement('span', null, `✓ ${displayStats.files} files changed`),
            displayStats.additions > 0
              ? createElement('span', { className: css.statsAdd }, `+${displayStats.additions}`)
              : null,
            displayStats.deletions > 0
              ? createElement('span', { className: css.statsDel }, `-${displayStats.deletions}`)
              : null,
          ),
          createElement('button', {
            onClick: () => setMode('review'),
            className: baseCss.buttonPrimary,
          }, '查看变更'),
        ),
      ),
    )
  }

  // ── Review 模式 ──────────────────────────────────────────────────
  return createElement(ErrorBoundary, null,
    createElement('div', { className: css.panel },
      error !== null ? createElement('p', { className: css.error }, error) : null,

      // 头部:Turn + 状态 + 摘要 + 风险信号 + 模式/更多开关。
      createElement('div', { className: css.header },
        createElement('div', { className: css.headerMain },
          createElement('div', { className: css.headerLine },
            createElement('span', { className: css.headerTitle }, name),
            createElement('span', { className: sessionStatusClass(status, baseCss, css) }, sessionStatusZh(status)),
          ),
          createElement('div', { className: css.headerSub },
            createElement('span', { className: css.headerSummary }, summary),
            createElement('span', { className: css.headerStats },
              createElement('span', null, `${displayStats.files} 个文件`),
              displayStats.additions > 0
                ? createElement('span', { className: css.statsAdd }, `+${displayStats.additions}`)
                : null,
              displayStats.deletions > 0
                ? createElement('span', { className: css.statsDel }, `-${displayStats.deletions}`)
                : null,
            ),
          ),
        ),
        createElement('div', { className: css.headerRight },
          createElement(RiskSignal, { level: signal.level, hint: signal.hint }),
          createElement('button', {
            onClick: () => setMode('focus'),
            className: baseCss.buttonGhost,
            title: '收起为聚焦卡片',
          }, '聚焦'),
          createElement('button', {
            onClick: () => setMoreOpen(!moreOpen),
            className: moreOpen ? baseCss.buttonPrimary : baseCss.buttonGhost,
            title: 'AI 审查 / 风险 / 验证 / Git / 历史 / 修复',
          }, '···'),
        ),
      ),

      // V-4 顶部固定批量操作条 + V-11 过滤。
      createElement('div', { className: css.actionBar },
        createElement('div', { className: css.filterTabs },
          filterTab('all', filter, '全部', () => setFilter('all')),
          filterTab('pending', filter, '待处理', () => setFilter('pending')),
          filterTab('issues', filter, `问题${issueIds.size > 0 ? ` ${issueIds.size}` : ''}`, () => setFilter('issues')),
        ),
        createElement('div', { className: css.batchOps },
          pendingCount > 0
            ? createElement('span', { className: css.pendingBadge }, `${pendingCount} 项待审查`)
            : null,
          createElement('button', {
            onClick: () => applyAll(false),
            disabled: busy || pendingCount === 0,
            className: baseCss.buttonPrimary,
          }, busy ? '处理中…' : '✓ 全部应用'),
          createElement('button', {
            onClick: rejectAll,
            disabled: busy || pendingCount === 0,
            className: baseCss.buttonDanger,
          }, '拒绝'),
          appliedTotal > 0
            ? createElement('button', {
              onClick: rollbackAll,
              disabled: busy,
              className: baseCss.buttonGhost,
            }, '全部回滚')
            : null,
        ),
      ),

      // 轻确认块:有风险时给 [查看] [仍然全部应用(force)]。
      warnState !== null
        ? createElement(WarnBlock, {
          state: warnState,
          onDismiss: () => setWarnState(null),
          onForce: () => applyAll(true),
        })
        : null,

      // toast(含 Undo)。
      toast !== null
        ? createElement('div', {
          className: toast.kind === 'error' ? css.toastError : toast.kind === 'warn' ? css.toastWarn : css.toastOk,
        },
        createElement('span', null, toast.text),
        toast.undo !== undefined
          ? createElement('button', { onClick: toast.undo, className: baseCss.buttonMini }, 'Undo')
          : null,
        createElement('button', { onClick: () => setToast(null), className: css.toastClose }, '×'),
        )
        : null,

      // V-7 未保存修改确认条。
      pendingSelect !== null
        ? createElement('div', { className: css.unsavedBar },
          createElement('span', { className: css.unsavedText }, '未保存的修改'),
          createElement('button', { onClick: () => confirmPendingSelect('save'), className: baseCss.buttonPrimary }, '保存并切换'),
          createElement('button', { onClick: () => confirmPendingSelect('discard'), className: baseCss.buttonGhost }, '放弃并切换'),
          createElement('button', { onClick: () => confirmPendingSelect('cancel'), className: baseCss.buttonGhost }, '取消'),
        )
        : null,

      createElement('div', { className: css.body },
        createElement(ChangeTree, {
          // 按会话重置:切换会话时目录折叠状态与展示模式重新初始化。
          key: sessionId,
          changes: filteredChanges,
          selected: filteredChanges.some(c => c.id === selectedChange) ? selectedChange : null,
          onSelect: handleSelect,
          onApprove: (id) => quickAction(id, 'approve'),
          onReject: (id) => quickAction(id, 'reject'),
          onRollback: (id) => quickAction(id, 'rollback'),
          onRepend: (id) => quickAction(id, 'repend'),
          disabled: panelLocked,
          // S-6:策略 deny 的变更显示 ⛔。
          deniedIds,
        }),
        change === null
          ? createElement('div', { className: css.centerEmpty },
            changes.length > 0
              ? '仅记录了命令执行，没有文件变更可审查'
              : '暂无文件变更，让 agent 修改文件后会自动出现在这里')
          : createElement('div', { className: css.viewerWrap },
            createElement(DiffViewer, {
              change,
              mode: diffMode,
              onModeChange: setDiffMode,
              draft: editorDraft,
              onDraftChange: setEditorDraft,
              onSaved: (after) => {
                api.editChange(change.id, after)
                  .then(afterAction)
                  .catch(err => setError(err instanceof Error ? err.message : String(err)))
              },
              disabled: panelLocked,
            }),
            createElement(ReviewBar, {
              change,
              api,
              onAction: afterAction,
              onError: (message) => setError(message),
              disabled: panelLocked,
            }),
          ),
        moreOpen
          ? createElement(IntelligencePanel, {
            sessionId,
            workspace,
            api,
            changes: fileChanges,
            onLocate: locator,
            onChanged: afterAction,
          })
          : null,
      ),
    ),
  )
}

/** 轻确认块:有风险的批量应用。 */
function WarnBlock(props: {
  state: WarnState
  onDismiss: () => void
  onForce: () => void
}): ReactElement {
  const { state, onDismiss, onForce } = props
  const [expanded, setExpanded] = useState(false)
  const text = state.kind === 'deny'
    ? `⛔ ${state.items.length} 个变更被策略拦截`
    : `⚠ ${state.items.length} 个变更存在外部修改`
  return createElement('div', { className: css.warnBlock },
    createElement('div', { className: css.warnHead },
      createElement('span', null, text),
      createElement('button', { onClick: () => setExpanded(!expanded), className: baseCss.buttonMini }, expanded ? '收起' : '查看'),
      createElement('button', { onClick: onForce, className: baseCss.buttonPrimary }, '仍然全部应用'),
      createElement('button', { onClick: onDismiss, className: baseCss.buttonGhost }, '取消'),
    ),
    expanded
      ? createElement('ul', { className: css.warnList },
        state.items.map(item => createElement('li', { key: item.id, className: css.warnItem },
          createElement('span', { className: css.warnId }, item.id),
          createElement('span', null, item.message),
        )),
      )
      : null,
  )
}

function filterTab(value: ChangeFilter, current: ChangeFilter, label: string, onClick: () => void): ReactElement {
  return createElement('button', {
    onClick,
    className: current === value ? css.filterTabActive : css.filterTab,
  }, label)
}

/** 会话状态 → 徽标类（active=工作、completed=成功、failed=突出）。 */
function sessionStatusClass(status: string, base: typeof baseCss, own: typeof css): string {
  switch (status) {
    case 'active': return base.badgeWarn
    case 'completed': return base.badgeSuccess
    case 'failed': return base.badgeError
    default: return base.badge
  }
}

/** 会话状态 → 中文。 */
function sessionStatusZh(status: string): string {
  switch (status) {
    case 'active': return '进行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    default: return '已取消'
  }
}

/** Match a change path against a finding path (suffix or exact). */
function findingPathMatches(changePath: string, findingPath: string): boolean {
  if (findingPath.length === 0) return false
  return changePath === findingPath || changePath.endsWith(findingPath)
}

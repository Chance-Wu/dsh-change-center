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
  ActionResult, ChangeCenterApi, GitActionResult, GitResponse, WireAcceptAllResult, WireChange, WireHistoryEvent, WirePolicyEvaluation, WirePolicyHit, WireReview, WireRisk,
} from './index.ts'
import { ChangeTree, dedupeByPath, relativePath } from './ChangeTree.tsx'
import type { DiffMode } from './DiffViewer.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { TimelineView } from './TimelineView.tsx'
import { OPERATION_MARK } from './i18n.ts'
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
  /**
   * 只读面(设置变更中心):只记录和展示内容 —— 隐藏全部操作
   * (应用/拒绝/回滚/撤销、Git、编辑、AI 审查运行、快捷键)。
   */
  readOnly?: boolean
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
/** 4.x Task Capsule 状态:会话状态 + 变更状态派生(Linear/Raycast 风格)。 */
interface CapsuleState {
  label: string
  tone: 'active' | 'pending' | 'applied' | 'rejected' | 'error' | 'neutral'
}

function deriveCapsule(status: string, changes: WireChange[]): CapsuleState {
  const applied = changes.filter(c => c.status === 'applied').length
  const rejected = changes.filter(c => c.status === 'rejected').length
  const pending = changes.filter(c => c.status === 'pending' || c.status === 'approved').length
  if (status === 'active') return { label: '进行中', tone: 'active' }
  if (status === 'failed') return { label: '失败', tone: 'error' }
  if (status === 'cancelled') return { label: '已取消', tone: 'neutral' }
  if (changes.length > 0 && pending === 0 && rejected === 0 && applied > 0) {
    return { label: '已应用', tone: 'applied' }
  }
  if (rejected > 0) return { label: '已拒绝', tone: 'rejected' }
  return { label: '待确认', tone: 'pending' }
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
    defaultMode = 'review', onEditorDirtyChange, summary: persistedSummary, readOnly = false,
  } = props
  const [changes, setChanges] = useState<WireChange[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [selectedChange, setSelectedChange] = useState<string | null>(null)
  // 默认并排(完整双栏,直观展示改动);聚焦/统一/编辑为可选视图。
  const [diffMode, setDiffMode] = useState<DiffMode>('side-by-side')
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
  // 4.1 Change Timeline:会话事件序列(供 Focus 迷你时间轴与 More 完整时间轴)。
  const [timeline, setTimeline] = useState<WireHistoryEvent[]>([])
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // 4.x Focus Git panel:手动 add/commit/push。
  const [gitInfo, setGitInfo] = useState<GitResponse | null>(null)
  const [gitOpen, setGitOpen] = useState(true)
  const [commitMsg, setCommitMsg] = useState('')
  const [pushConfirm, setPushConfirm] = useState(false)
  const [gitBusy, setGitBusy] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitLogs, setGitLogs] = useState<string[]>([])

  const refresh = (): void => {
    setTreeLoading(true)
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
      .finally(() => setTreeLoading(false))
  }

  // 情报数据:风险信号与 Issues 过滤器只读这些轻量结果。
  const refreshIntelligence = (): void => {
    api.riskGet(sessionId).then(setRisk).catch(() => setRisk(null))
    api.policyEvaluation(sessionId)
      .then(({ evaluations: evs, hits }) => { setEvaluations(evs); setPolicyHits(hits) })
      .catch(() => { setEvaluations([]); setPolicyHits([]) })
    api.reviewGet(sessionId).then(setReview).catch(() => setReview(null))
    // 4.1:时间轴数据(与 More 完整时间轴共用)。
    api.timeline(sessionId)
      .then(body => setTimeline(body.events))
      .catch(() => setTimeline([]))
  }

  useEffect(() => {
    refresh()
    refreshIntelligence()
  }, [sessionId])

  // 2.2 L-2/L-4:实时变更流 —— AI 工作中文件逐条出现、apply/rollback 实时同步,
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

  // 3.0.4:Undo 是短生命周期操作状态 —— 5 秒倒计时后消失,回滚仍走 Review → 全部回滚。
  const [undoRemaining, setUndoRemaining] = useState<number | null>(null)
  useEffect(() => {
    if (toast?.undo === undefined) {
      setUndoRemaining(null)
      return
    }
    setUndoRemaining(5)
    const timer = setInterval(() => {
      setUndoRemaining(prev => {
        if (prev === null || prev <= 1) {
          clearInterval(timer)
          return null
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
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
  const capsule = deriveCapsule(status, fileChanges)
  // Focus Git panel 数据:repo 信息 + 未提交文件。
  const gitRepo = gitInfo?.repo !== undefined && !('error' in gitInfo.repo) ? gitInfo.repo : null
  const gitEntries = gitInfo?.entries ?? []
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

  // 3.0.6:待处理 = pending + approved + failed(failed 仍需用户处理);问题 = 需要用户注意的集合。
  const filteredChanges = useMemo(() => {
    if (filter === 'pending') {
      return fileChanges.filter(c => c.status === 'pending' || c.status === 'approved' || c.status === 'failed')
    }
    if (filter === 'issues') return fileChanges.filter(c => issueIds.has(c.id))
    return fileChanges
  }, [fileChanges, filter, issueIds])

  // V-7:脏状态 = 编辑草稿 ≠ 当前版本的 after。
  const editorDirty = change !== null && editorDraft !== (change.after ?? '')
  // 选中变更切换时同步编辑器草稿到新变更的 after。refresh 自动选中首个变更
  // 时走不到 selectChange,这里兜底;用户正在编辑当前变更时 change.id 不变,不会被打断。
  useEffect(() => {
    if (change !== null) setEditorDraft(change.after ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change?.id])
  useEffect(() => {
    onEditorDirtyChange?.(editorDirty)
  }, [editorDirty])

  // 面板锁:批量进行中 / 结果展示期间 / 编辑器有未保存修改,单条入口全部禁用。
  const panelLocked = busy || toast !== null || warnState !== null || editorDirty

  // P-3 键盘快捷键(仅高频动作;输入框/编辑器聚焦时全部短路)。
  // 只读面没有操作,快捷键整体关闭。
  useEffect(() => {
    if (mode !== 'review' || readOnly) return
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key === 'k') {
        event.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (mod && event.key === 'Enter') {
        event.preventDefault()
        if (change !== null && !panelLocked && actionsFor(change.status).canApply) {
          void api.applyChange(change.id).then(afterAction).catch(err => setError(err instanceof Error ? err.message : String(err)))
        }
        return
      }
      const currentIndex = change !== null ? filteredChanges.findIndex(c => c.id === change.id) : -1
      switch (event.key) {
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
        case 'm': setMoreOpen(true); return
        case 'a':
          if (change !== null && !panelLocked && actionsFor(change.status).canApply) {
            void api.applyChange(change.id).then(afterAction).catch(err => setError(err instanceof Error ? err.message : String(err)))
          }
          return
        case 'u':
        case 'z':
          if (change !== null && !panelLocked && actionsFor(change.status).canRollback) quickAction(change.id, 'rollback')
          return
        case 'Escape':
          if (shortcutsOpen) { setShortcutsOpen(false); return }
          setMode('focus')
          return
        default: return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, change, filteredChanges, panelLocked, shortcutsOpen])

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

  /** 5.x 文件导航:跨文件切换(键盘 j/k 之外的可见入口)。 */
  const navigateChange = (delta: number): void => {
    const currentIndex = change !== null ? filteredChanges.findIndex(c => c.id === change.id) : -1
    const next = currentIndex + delta
    if (next >= 0 && next < filteredChanges.length) {
      handleSelect(filteredChanges[next]!.id)
    }
  }

  /** Tree quick actions + the review bar share one action path. */
  const quickAction = (id: string, action: 'rollback' | 'repend'): void => {
    api.changeAction(id, action)
      .then(afterAction)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  /** 3.x:树行主操作 = 应用/重试应用(与 ReviewBar 同一路径)。 */
  const quickApply = (id: string): void => {
    api.applyChange(id)
      .then((result: ActionResult) => {
        afterAction()
        if ((result as { kind?: string }).kind === 'applied') {
          // 应用成功即给撤销入口,误点可立即回滚。
          setToast({ text: '✓ 已应用', kind: 'ok', undo: () => quickAction(id, 'rollback') })
        } else if ((result as { kind?: string }).kind === 'conflict') {
          setToast({ text: '应用冲突:磁盘内容与捕获版本不一致', kind: 'warn' })
        }
      })
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

  const refreshGit = (): void => {
    api.gitStatus(sessionId).then(setGitInfo).catch(() => setGitInfo(null))
    api.gitLog(sessionId).then(r => { if (r.entries !== undefined) setGitLogs(r.entries) }).catch(() => setGitLogs([]))
  }
  useEffect(() => {
    if (mode !== 'focus') return
    refreshGit()
  }, [mode, sessionId])

  /** Git 写操作统一反馈:成功 toast + 刷新状态;失败显示在面板内。 */
  const runGit = (action: () => Promise<GitActionResult>, okText: string): void => {
    setGitBusy(true)
    setGitError(null)
    action()
      .then(result => {
        if (result.ok) {
          setToast({ text: okText, kind: 'ok' })
          refreshGit()
        } else {
          setGitError(result.error ?? 'git 操作失败')
        }
      })
      .catch(err => setGitError(err instanceof Error ? err.message : String(err)))
      .finally(() => setGitBusy(false))
  }

  const doAddAll = (): void => {
    runGit(() => api.gitAdd(sessionId), '✓ 已暂存全部变更')
  }
  const doCommit = (): void => {
    const message = commitMsg.trim()
    if (message.length === 0) return
    setCommitMsg('')
    runGit(() => api.gitCommit(sessionId, message), '✓ 已提交')
  }
  const doPush = (): void => {
    if (!pushConfirm) {
      setPushConfirm(true)
      return
    }
    setPushConfirm(false)
    runGit(() => api.gitPush(sessionId), '✓ 已推送')
  }

  const locator = (id: string): void => {
    setMode('review')
    setSelectedChange(id)
    const target = fileChanges.find(c => c.id === id)
    setEditorDraft(target?.after ?? '')
  }

  // ── Focus 模式(3.x):状态卡 —— 只回答「有什么变化?要不要应用?」 ─────
  // 只读面始终停留在 Review(展示)模式,不进入 Focus 操作卡。
  if (mode === 'focus' && !readOnly) {
    // 3.0.5 风险文字行(不显示任何分数/规则)。
    const riskLine = signal.level === 'block'
      ? `⛔ ${deniedIds.size} 个变更被策略阻止`
      : signal.level === 'warn'
        ? `⚠ ${issueIds.size} 个变更需要注意`
        : '✓ 未发现风险'
    return createElement(ErrorBoundary, null,
      createElement('div', { className: css.panel },
        error !== null ? createElement('p', { className: css.error }, error) : null,
        // 4.x turn 状态卡 与 Git 操作卡 左右并列(focusRow)。
        createElement('div', { className: css.focusRow },
        createElement('div', { className: css.focusCard },
          createElement('div', { className: css.focusHead },
            createElement('span', { className: css.focusTitle }, name),
            createElement('span', { className: sessionStatusClass(status, baseCss, css) }, sessionStatusZh(status)),
          ),
          createElement('div', { className: css.focusSummary }, summary),
          createElement('div', { className: css.focusStats },
            createElement('span', null, `✓ ${displayStats.files} 个文件已修改`),
            displayStats.additions > 0
              ? createElement('span', { className: css.statsAdd }, `+${displayStats.additions}`)
              : null,
            displayStats.deletions > 0
              ? createElement('span', { className: css.statsDel }, `-${displayStats.deletions}`)
              : null,
          ),
          createElement('div', { className: css.focusRisk }, riskLine),
          createElement('div', { className: css.focusStatus },
            status === 'active'
              ? createElement('span', { className: css.focusWorking }, '● AI 工作中')
              : createElement('span', null, '● 就绪'),
          ),
          // 4.1 Change Timeline:Focus 迷你时间轴(展开显示最近事件)。
          createElement('div', { className: css.focusTimeline },
            createElement('button', {
              onClick: () => setTimelineOpen(!timelineOpen),
              className: css.timelineToggle,
            }, `${timelineOpen ? '▾' : '▸'} Timeline`),
            timelineOpen
              ? createElement(TimelineView, { events: timeline, changes: fileChanges, limit: 5 })
              : null,
          ),
          // 4.4 Agent Intent:Focus 文件分解(修改了什么,一目了然)。
          createElement('div', { className: css.focusTimeline },
            createElement('button', {
              onClick: () => setFilesOpen(!filesOpen),
              className: css.timelineToggle,
            }, `${filesOpen ? '▾' : '▸'} 修改 ${fileChanges.length} 个文件`),
            filesOpen
              ? createElement('div', { className: css.focusFiles },
                fileChanges.slice(0, 12).map(change => {
                  const counts = countDiff(change.before, change.after)
                  return createElement('div', { key: change.id, className: css.focusFile },
                    createElement('span', { className: focusMarkClass(change.operation) }, OPERATION_MARK[change.operation] ?? '?'),
                    createElement('span', { className: css.focusFileName }, relativePath(change)),
                    counts.additions + counts.deletions > 0
                      ? createElement('span', { className: css.focusFileCounts },
                        counts.additions > 0 ? createElement('span', { className: css.statsAdd }, `+${counts.additions}`) : null,
                        counts.deletions > 0 ? createElement('span', { className: css.statsDel }, `-${counts.deletions}`) : null,
                      )
                      : null,
                  )
                }),
                fileChanges.length > 12
                  ? createElement('div', { className: css.focusFileMore }, `… 共 ${fileChanges.length} 个文件`)
                  : null,
              )
              : null,
          ),
          // 3.0.3:Focus 只给一个主要动作;无待审时显示「✓ 已全部应用」。
          createElement('div', { className: css.focusActions },
            createElement('button', {
              onClick: () => setMode('review'),
              className: baseCss.buttonGhost,
            }, '审查'),
            createElement('button', {
              onClick: () => applyAll(false),
              disabled: busy || pendingCount === 0,
              className: baseCss.buttonPrimary,
            }, busy ? '处理中…' : pendingCount === 0 ? '✓ 已全部应用' : '全部应用'),
          ),
        ),
        // 4.x Git 操作独立于 turn 状态卡(与变更审查分开管理)。
        createElement('div', { className: css.gitPanel },
          createElement('div', { className: css.gitPanelHead },
            createElement('button', {
              onClick: () => setGitOpen(!gitOpen),
              className: css.timelineToggle,
            }, `${gitOpen ? '▾' : '▸'} Git 操作`),
            gitRepo !== null
              ? createElement('span', { className: css.gitMeta },
                `${gitRepo.branch} · ${gitRepo.head}${gitRepo.dirty ? ' · 有未提交修改' : ' · 干净'}`)
              : null,
          ),
          gitOpen
            ? createElement('div', { className: css.gitPanelBody },
              gitError !== null
                ? createElement('div', { className: css.gitError }, gitError)
                : null,
              gitEntries.length > 0
                ? createElement('div', { className: css.gitFiles },
                  gitEntries.slice(0, 6).map(entry => createElement('div', { key: `${entry.code} ${entry.path}`, className: css.gitFileRow },
                    createElement('span', { className: css.gitFileCode }, entry.code),
                    createElement('span', { className: css.gitFilePath }, entry.path),
                  )),
                  gitEntries.length > 6
                    ? createElement('div', { className: css.gitMore }, `… 共 ${gitEntries.length} 项`)
                    : null,
                )
                : createElement('div', { className: css.gitClean }, '工作区干净'),
              gitLogs.length > 0
                ? createElement('div', { className: css.gitLogs },
                  createElement('div', { className: css.gitLogsTitle }, '最近提交'),
                  gitLogs.slice(0, 5).map(line => {
                    const space = line.indexOf(' ')
                    const hash = space > 0 ? line.slice(0, space) : line
                    const subject = space > 0 ? line.slice(space + 1) : ''
                    return createElement('div', { key: line, className: css.gitLogRow },
                      createElement('span', { className: css.gitLogHash }, hash),
                      subject.length > 0 ? createElement('span', { className: css.gitLogSubject }, subject) : null,
                    )
                  }),
                )
                : null,
              createElement('div', { className: css.gitOps },
                createElement('button', {
                  onClick: doAddAll,
                  disabled: gitBusy || gitEntries.length === 0,
                  className: baseCss.buttonGhost,
                }, '全部暂存'),
                createElement('input', {
                  className: `${baseCss.input} ${css.gitCommitInput}`,
                  placeholder: '提交信息…',
                  value: commitMsg,
                  onChange: (event: { target: { value: string } }) => setCommitMsg(event.target.value),
                  onKeyDown: (event: KeyboardEvent) => {
                    if (event.key === 'Enter') doCommit()
                  },
                }),
                createElement('button', {
                  onClick: doCommit,
                  disabled: gitBusy || commitMsg.trim().length === 0,
                  className: baseCss.buttonPrimary,
                }, '提交'),
              ),
              createElement('div', { className: css.gitPushRow },
                pushConfirm
                  ? createElement('span', { className: css.gitPushHint }, '确认推送到 origin?')
                  : null,
                createElement('button', {
                  onClick: doPush,
                  disabled: gitBusy,
                  className: pushConfirm ? baseCss.buttonPrimary : baseCss.buttonGhost,
                }, pushConfirm ? '确认推送' : '推送'),
              ),
            )
            : null,
        ),
        ),
        // 批量反馈(toast/轻确认)在 Focus 下同样可见。
        toast !== null ? renderToast(toast, css, baseCss, setToast, undoRemaining) : null,
        warnState !== null
          ? createElement(WarnBlock, {
            state: warnState,
            onDismiss: () => setWarnState(null),
            onForce: () => applyAll(true),
          })
          : null,
      ),
    )
  }

  // ── Review 模式 ──────────────────────────────────────────────────
  return createElement(ErrorBoundary, null,
    createElement('div', { className: css.panel },
      error !== null ? createElement('p', { className: css.error }, error) : null,

      // 4.x Task Capsule 头部:状态胶囊 + 标题 + 统计(去 Git diff 感)。
      createElement('div', { className: css.header },
        createElement('div', { className: css.headerMain },
          createElement('div', { className: css.capsuleLine },
            createElement('span', { className: css.capsuleDot, 'data-tone': capsule.tone }),
            createElement('span', { className: css.capsuleLabel, 'data-tone': capsule.tone }, capsule.label),
            createElement('span', { className: css.capsuleHint },
              pendingCount > 0 ? `${pendingCount} 项待确认` : '全部已处理'),
          ),
          createElement('div', { className: css.headerTitle }, name),
          createElement('div', { className: css.headerSub },
            createElement('span', { className: css.headerStats },
              createElement('span', null, `${displayStats.files} 个文件`),
              displayStats.additions > 0
                ? createElement('span', { className: css.statsAdd }, `+${displayStats.additions}`)
                : null,
              displayStats.deletions > 0
                ? createElement('span', { className: css.statsDel }, `-${displayStats.deletions}`)
                : null,
            ),
            summary.length > 0
              ? createElement('span', { className: css.headerSummary }, summary)
              : null,
          ),
        ),
        createElement('div', { className: css.headerRight },
          createElement(RiskSignal, { level: signal.level, hint: signal.hint }),
          // 只读面不提供快捷键/聚焦卡/More 操作面板。
          readOnly ? null : createElement('button', {
            onClick: () => setShortcutsOpen(!shortcutsOpen),
            className: baseCss.buttonGhost,
            title: '快捷键(⌘K)',
          }, '⌘K'),
          readOnly ? null : createElement('button', {
            onClick: () => setMode('focus'),
            className: baseCss.buttonGhost,
            title: '收起为聚焦卡片',
          }, '聚焦'),
          readOnly ? null : createElement('button', {
            onClick: () => setMoreOpen(!moreOpen),
            className: moreOpen ? baseCss.buttonPrimary : baseCss.buttonGhost,
            title: 'AI 审查 / 风险 / 验证 / Git / 历史 / 修复',
          }, '···'),
        ),
      ),

      // ⌘K 快捷键帮助浮层。
      shortcutsOpen
        ? createElement('div', { className: css.shortcutsOverlay, onClick: () => setShortcutsOpen(false) },
          createElement('div', { className: css.shortcutsCard, onClick: (event: MouseEvent) => event.stopPropagation() },
            createElement('div', { className: css.shortcutsTitle }, '快捷键'),
            createElement('div', { className: css.shortcutsRow }, createElement('kbd', null, 'A'), ' 应用当前变更'),
            createElement('div', { className: css.shortcutsRow }, createElement('kbd', null, 'U'), ' 回滚当前变更'),
            createElement('div', { className: css.shortcutsRow }, createElement('kbd', null, 'J'), createElement('kbd', null, 'K'), ' 上 / 下切换文件'),
            createElement('div', { className: css.shortcutsRow }, createElement('kbd', null, 'M'), ' 展开 AI 摘要面板'),
            createElement('div', { className: css.shortcutsRow }, createElement('kbd', null, '⌘Enter'), ' 应用当前变更'),
            createElement('div', { className: css.shortcutsRow }, createElement('kbd', null, 'Esc'), ' 收起为聚焦卡片'),
          ),
        )
        : null,

      // V-11 过滤 tabs + 待审徽标(批量操作移到底部 Action Dock)。
      createElement('div', { className: css.actionBar },
        createElement('div', { className: css.filterTabs },
          filterTab('all', filter, '全部', () => setFilter('all')),
          filterTab('pending', filter, '待处理', () => setFilter('pending')),
          filterTab('issues', filter, `问题${issueIds.size > 0 ? ` ${issueIds.size}` : ''}`, () => setFilter('issues')),
        ),
        pendingCount > 0
          ? createElement('span', { className: css.pendingBadge }, `${pendingCount} 项待确认`)
          : null,
      ),

      // 轻确认块:有风险时给 [查看] [仍然全部应用(force)]。
      warnState !== null
        ? createElement(WarnBlock, {
          state: warnState,
          onDismiss: () => setWarnState(null),
          onForce: () => applyAll(true),
        })
        : null,

      // toast(含 Undo 倒计时,3.0.4)。
      toast !== null ? renderToast(toast, css, baseCss, setToast, undoRemaining) : null,

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
          // 只读面:树只展示,行上不挂任何操作。
          ...(readOnly
            ? { disabled: true }
            : {
              onRollback: (id: string) => quickAction(id, 'rollback'),
              onRepend: (id: string) => quickAction(id, 'repend'),
              onApply: quickApply,
              disabled: panelLocked,
              deniedIds,
            }),
          loading: treeLoading,
        }),
        moreOpen
          ? createElement(IntelligencePanel, {
            sessionId,
            workspace,
            api,
            changes: fileChanges,
            timeline,
            onLocate: locator,
            onChanged: afterAction,
          })
          : null,
        change === null
          ? createElement('div', { className: css.centerEmpty },
            changes.length > 0
              ? '仅记录了命令执行，没有文件变更可展示'
              : '暂无文件变更，让 agent 修改文件后会自动出现在这里')
          : createElement('div', { className: css.viewerWrap },
            createElement(DiffViewer, {
              change,
              mode: diffMode,
              onModeChange: setDiffMode,
              draft: editorDraft,
              onDraftChange: setEditorDraft,
              onSaved: (after) => {
                // 流程优化:编辑保存 = 更新记录 + 立即应用(一步到位);冲突时提示处理。
                api.editChange(change.id, after)
                  .then(() => api.applyChange(change.id))
                  .then((result: ActionResult) => {
                    afterAction()
                    if ((result as { kind?: string }).kind === 'conflict' || (result as { error?: string }).error !== undefined) {
                      setToast({ text: '已保存，但应用时发现外部修改，可查看差异后处理', kind: 'warn' })
                    } else {
                      setToast({ text: '✓ 已保存并应用', kind: 'ok', undo: () => quickAction(change.id, 'rollback') })
                    }
                  })
                  .catch(err => setError(err instanceof Error ? err.message : String(err)))
              },
              disabled: panelLocked,
              // 只读面:不提供编辑与 AI 审查运行。
              readOnly,
              review,
              changes: fileChanges,
              onSelectChange: (id) => { setSelectedChange(id); setDiffMode('focus') },
              onRunReview: readOnly ? undefined : () => {
                api.reviewRun(sessionId).then(afterAction).catch(err => setError(err instanceof Error ? err.message : String(err)))
              },
            }),
            // 只读面:隐藏逐条操作条。
            readOnly ? null : createElement(ReviewBar, {
              change,
              api,
              onAction: afterAction,
              onError: (message) => setError(message),
              disabled: panelLocked,
              onPrev: () => navigateChange(-1),
              onNext: () => navigateChange(1),
            }),
          ),
      ),
      // 4.x 底部 Action Dock:选中计数 + 回滚/拒绝全部/全部应用(只读面隐藏)。
      readOnly ? null : createElement('div', { className: css.actionDock },
        createElement('div', { className: css.dockInfo },
          createElement('span', { className: css.dockCount }, `${fileChanges.length} 个变更`),
          change !== null
            ? createElement('span', { className: css.dockSelected }, `已选 ${change.path.split('/').pop()}`)
            : null,
        ),
        createElement('div', { className: css.dockActions },
          appliedTotal > 0
            ? createElement('button', {
              onClick: rollbackAll,
              disabled: busy,
              className: baseCss.buttonGhost,
              title: '撤销本会话所有已应用的变更',
            }, '↶ 回滚')
            : null,
          createElement('button', {
            onClick: () => applyAll(false),
            disabled: busy || pendingCount === 0,
            className: baseCss.buttonPrimary,
          }, busy ? '处理中…' : '✓ 全部应用'),
        ),
      ),
    ),
  )
}

/** toast(含 3.0.4 Undo 倒计时);Focus 与 Review 共用。 */
function renderToast(
  toast: Toast,
  cssMap: Record<string, string>,
  base: Record<string, string>,
  setToast: (toast: Toast | null) => void,
  undoRemaining: number | null,
): ReactElement {
  return createElement('div', {
    className: toast.kind === 'error' ? cssMap.toastError : toast.kind === 'warn' ? cssMap.toastWarn : cssMap.toastOk,
  },
  createElement('span', null, toast.text),
  // Undo 是短生命周期操作:倒计时结束即消失,回滚仍走 Review → 全部回滚。
  toast.undo !== undefined && undoRemaining !== null
    ? createElement('button', { onClick: toast.undo, className: base.buttonMini }, `Undo ${undoRemaining}s`)
    : null,
  createElement('button', { onClick: () => setToast(null), className: cssMap.toastClose }, '×'),
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

/** 4.4 Focus 文件分解行的操作徽标。 */
function focusMarkClass(operation: string): string {
  switch (operation) {
    case 'create': return css.markCreate
    case 'delete': return css.markDelete
    default: return css.markModify
  }
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

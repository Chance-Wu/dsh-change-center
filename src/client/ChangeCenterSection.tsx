/**
 * Change Center settings section — Vibe UI 信息架构（V-1/V-10/V-12/V-13）:
 *
 *   Change Center
 *   ├── 当前   —— 正在发生的 Turn（Focus 卡片）;自动跟随最新 active 会话
 *   ├── 会话   —— 历史 Turn,按 今天/昨天/更早 分组浏览
 *   └── (右侧) —— 选中会话的共享审查面板
 *
 * 会话行只展示「AI 做过什么」:状态图标 + Turn 名 + 时间 + 文件数/±行数,
 * 不暴露 Session ID / Risk / Policy 等数据库字段。编辑器有未保存修改时,
 * 切换会话先经 放弃并切换/取消 守卫（V-7）。
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useState, type ReactElement } from 'react'
import type { ChangeCenterApi, WireSession } from './index.ts'
import { ChangeReviewPanel } from './ChangeReviewPanel.tsx'
import css from './ChangeCenterSection.module.css'

/** Props for the section: settings-shell owner share plus the API handle. */
export interface ChangeCenterSectionProps {
  close: () => void
  api: ChangeCenterApi
}

/** 会话列表每页条数（host 分页上限 500）。 */
const PAGE_SIZE = 50

/** 顶层视图：当前（正在发生的 Turn） / 会话（历史时间线）。 */
type SectionView = 'current' | 'sessions'

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The settings-surface review: current-turn / history views on the left, one
 * session's review panel on the right.
 */
export function ChangeCenterSection(props: ChangeCenterSectionProps): ReactElement {
  const { api } = props
  const [sessions, setSessions] = useState<WireSession[]>([])
  const [total, setTotal] = useState(0)
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [view, setView] = useState<SectionView>('current')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // V-13:自动跟随当前正在工作的 Turn;用户手动选择后暂停,可「回到当前」。
  const [followCurrent, setFollowCurrent] = useState(true)
  // V-7:面板编辑器脏状态 → 切换会话先确认。
  const [editorDirty, setEditorDirty] = useState(false)
  const [pendingSession, setPendingSession] = useState<string | null>(null)

  const refreshSessions = (): void => {
    api.listSessions({ limit: PAGE_SIZE, offset: 0 })
      .then(page => {
        setSessions(page.items)
        setTotal(page.total)
        setLoading(false)
        if (selectedSession === null && page.items.length > 0) {
          setSelectedSession(activeOrNewest(page.items)?.id ?? page.items[0]!.id)
        }
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }

  // 会话超过一页时追加下一页；事件驱动的刷新会重置到第一页。
  const loadMore = (): void => {
    setLoadingMore(true)
    api.listSessions({ limit: PAGE_SIZE, offset: sessions.length })
      .then(page => {
        setSessions(prev => [...prev, ...page.items])
        setTotal(page.total)
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingMore(false))
  }

  useEffect(() => {
    refreshSessions()
    // 事件驱动:host 推送变更/会话事件时自动刷新列表。
    return api.subscribeEvents(() => refreshSessions())
  }, [])

  // V-13:自动跟随最新 active 会话(仅在用户未手动钉住其他会话时)。
  const newestActive = activeOrNewest(sessions)
  const isFollowing = followCurrent
  useEffect(() => {
    if (!isFollowing) return
    if (newestActive !== undefined && newestActive.id !== selectedSession) {
      setSelectedSession(newestActive.id)
    }
  }, [sessions])

  const session = sessions.find(s => s.id === selectedSession) ?? null

  /** 选择会话:有未保存修改时先经守卫。 */
  const handleSelectSession = (id: string): void => {
    if (editorDirty && id !== selectedSession) {
      setPendingSession(id)
      return
    }
    selectSession(id)
  }

  /** 真正切换;手动选择 → 停止自动跟随。 */
  const selectSession = (id: string): void => {
    setFollowCurrent(false)
    setSelectedSession(id)
  }

  /** V-13「回到当前」:恢复自动跟随并选中最新 active 会话。 */
  const backToCurrent = (): void => {
    setFollowCurrent(true)
    if (newestActive !== undefined) setSelectedSession(newestActive.id)
  }

  /** 有较新的 active 会话且用户已手动离开 → 显示「回到当前」。 */
  const showBackToCurrent = !followCurrent && newestActive !== undefined
    && newestActive.updatedAt > (session?.updatedAt ?? 0)

  return createElement('div', { className: css.section },
    createElement('div', { className: css.headerRow },
      createElement('div', { className: css.header }, '变更中心'),
      createElement('div', { className: css.viewTabs },
        createElement('button', {
          className: view === 'current' ? css.viewTabActive : css.viewTab,
          onClick: () => setView('current'),
        }, '当前'),
        createElement('button', {
          className: view === 'sessions' ? css.viewTabActive : css.viewTab,
          onClick: () => setView('sessions'),
        }, '会话'),
      ),
    ),
    error !== null ? createElement('div', { className: css.error }, error) : null,

    // 未保存修改守卫（V-7）:切换会话前确认。
    pendingSession !== null
      ? createElement('div', { className: css.unsavedBar },
        createElement('span', { className: css.unsavedText }, '未保存的修改'),
        createElement('button', {
          onClick: () => { selectSession(pendingSession); setPendingSession(null) },
          className: css.unsavedDiscard,
        }, '放弃并切换'),
        createElement('button', {
          onClick: () => setPendingSession(null),
          className: css.unsavedCancel,
        }, '取消'),
      )
      : null,

    createElement('div', { className: css.layout },
      // Left: 当前 Turn 卡片 / 历史时间线。
      createElement('div', { className: css.sessionList },
        loading
          ? createElement('div', { className: css.muted }, '加载中…')
          : sessions.length === 0
            ? createElement('div', { className: css.muted },
              '暂无变更会话。',
              createElement('br'),
              '让 agent 修改文件后,这里会出现按轮次(Turn)分组的变更。')
            : view === 'current'
              ? createElement(CurrentCard, {
                session: newestActive,
                selected: selectedSession,
                // 查看「当前」Turn 不停止自动跟随(V-13)。
                onOpen: (id) => {
                  if (editorDirty && id !== selectedSession) {
                    setPendingSession(id)
                    return
                  }
                  setSelectedSession(id)
                },
                onBackToCurrent: backToCurrent,
                showBackToCurrent,
              })
              : createElement(SessionTimeline, {
                sessions,
                selectedSession,
                onSelect: handleSelectSession,
                total,
                loadedCount: sessions.length,
                onLoadMore: loadMore,
                loadingMore,
              }),
      ),
      // Right: the shared review panel for the selected session.
      session === null
        ? createElement('div', { className: css.muted }, '请选择一个会话查看其变更')
        : createElement('div', { className: css.reviewWrap },
          createElement(ChangeReviewPanel, {
            sessionId: session.id,
            name: session.name,
            status: session.status,
            agentSessionId: session.agentSessionId,
            workspace: session.workspace,
            statistics: session.statistics,
            summary: session.summary,
            api,
            onChanged: refreshSessions,
            // 设置区点开会话 = 明确想审查 → 默认 Review 模式。
            defaultMode: 'review',
            onEditorDirtyChange: setEditorDirty,
          }),
        ),
    ),
  )
}

/** 当前视图：正在工作的 Turn 的 Focus 卡片（V-2 / V-13）。 */
function CurrentCard(props: {
  session: WireSession | undefined
  selected: string | null
  onOpen: (id: string) => void
  onBackToCurrent: () => void
  showBackToCurrent: boolean
}): ReactElement {
  const { session, selected, onOpen, onBackToCurrent, showBackToCurrent } = props
  if (session === undefined) {
    return createElement('div', { className: css.muted }, '没有进行中的 Turn;在「会话」中浏览历史。')
  }
  const meta = statusMetaOf(session)
  const isSelected = selected === session.id
  return createElement('div', {
    className: isSelected ? css.currentCardSelected : css.currentCard,
    onClick: () => onOpen(session.id),
  },
  createElement('div', { className: css.currentHead },
    createElement('span', { className: css.currentTitle }, session.name),
    createElement('span', { className: css.currentStatus }, meta.icon),
    session.status === 'active'
      ? createElement('span', { className: css.currentWorking }, '● AI 工作中')
      : null,
  ),
  createElement('div', { className: css.currentMeta },
    `${session.statistics.files} 个文件 · +${session.statistics.additions} -${session.statistics.deletions}`),
  createElement('div', { className: css.currentActions },
    createElement('button', {
      onClick: (event: MouseEvent) => { event.stopPropagation(); onOpen(session.id) },
      className: css.currentOpen,
    }, '查看变更'),
    showBackToCurrent
      ? createElement('button', {
        onClick: (event: MouseEvent) => { event.stopPropagation(); onBackToCurrent() },
        className: css.currentBack,
      }, '回到当前')
      : null,
  ),
  )
}

/** 会话视图：按 今天/昨天/更早 分组的历史时间线（V-10）。 */
function SessionTimeline(props: {
  sessions: WireSession[]
  selectedSession: string | null
  onSelect: (id: string) => void
  total: number
  loadedCount: number
  onLoadMore: () => void
  loadingMore: boolean
}): ReactElement {
  const { sessions, selectedSession, onSelect, total, loadedCount, onLoadMore, loadingMore } = props
  const groups = groupByDay(sessions)
  return createElement('div', { className: css.timeline },
    groups.map(group => createElement('div', { key: group.label, className: css.dayGroup },
      createElement('div', { className: css.dayLabel }, group.label),
      group.sessions.map(s => {
        const meta = statusMetaOf(s)
        return createElement('button', {
          key: s.id,
          className: css.sessionRow,
          'data-selected': selectedSession === s.id,
          onClick: () => onSelect(s.id),
        },
        createElement('span', { className: css.sessionIcon, title: meta.label }, meta.icon),
        createElement('span', { className: css.sessionMain },
          createElement('span', { className: css.sessionName }, s.name),
          createElement('span', { className: css.sessionMeta },
            `${s.statistics.files} 个文件 · +${s.statistics.additions} -${s.statistics.deletions} · ${timeOf(s.createdAt)}`),
        ),
        )
      }),
    )),
    loadedCount < total
      ? createElement('button', {
        className: css.loadMore,
        onClick: onLoadMore,
        disabled: loadingMore,
      }, loadingMore ? '加载中…' : `加载更多（${total - loadedCount}）`)
      : null,
  )
}

/** 当前会话在列表中的状态图标(会话状态,非变更状态)。 */
function statusMetaOf(session: WireSession): { icon: string; label: string } {
  switch (session.status) {
    case 'active': return { icon: '●', label: '进行中' }
    case 'completed': return { icon: '✓', label: '已完成' }
    case 'failed': return { icon: '!', label: '失败' }
    default: return { icon: '·', label: '已取消' }
  }
}

/** 最新 active 会话；没有则取最新 completed。 */
function activeOrNewest(sessions: WireSession[]): WireSession | undefined {
  const active = sessions.filter(s => s.status === 'active')
  if (active.length > 0) {
    return active.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
  }
  return sessions[0]
}

/** 按天分组(今天 / 昨天 / 更早),组内按 updatedAt 倒序。 */
function groupByDay(sessions: WireSession[]): { label: string; sessions: WireSession[] }[] {
  const now = Date.now()
  const todayStart = new Date(now).setHours(0, 0, 0, 0)
  const yesterdayStart = todayStart - DAY_MS
  const groups: { label: string; sessions: WireSession[] }[] = []
  const today: WireSession[] = []
  const yesterday: WireSession[] = []
  const earlier: WireSession[] = []
  for (const s of sessions) {
    if (s.updatedAt >= todayStart) today.push(s)
    else if (s.updatedAt >= yesterdayStart) yesterday.push(s)
    else earlier.push(s)
  }
  const sortDesc = (list: WireSession[]): WireSession[] => [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  if (today.length > 0) groups.push({ label: '今天', sessions: sortDesc(today) })
  if (yesterday.length > 0) groups.push({ label: '昨天', sessions: sortDesc(yesterday) })
  if (earlier.length > 0) groups.push({ label: '更早', sessions: sortDesc(earlier) })
  return groups
}

function timeOf(timestamp: number): string {
  const date = new Date(timestamp)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

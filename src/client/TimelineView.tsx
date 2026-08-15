/**
 * Session Timeline (4.1): renders the session's lifecycle events as a
 * readable timeline, joining each event's changeId to its relative path so
 * entries read like "10:32 Agent 修改 UserController.java" instead of raw
 * history rows. Used in the Focus card (mini, expandable) and in the More
 * panel (full).
 * @module dsh-change-center/client
 */

import { createElement, useMemo, type ReactElement } from 'react'
import type { WireChange, WireHistoryEvent } from './index.ts'
import { relativePath } from './ChangeTree.tsx'
import css from './TimelineView.module.css'

/** Props for the timeline view. */
export interface TimelineViewProps {
  events: WireHistoryEvent[]
  /** The session's changes, to resolve changeId → relative path. */
  changes: WireChange[]
  /** Show at most this many events (newest first); undefined = all. */
  limit?: number
}

/** One display row: time + icon + label. */
interface Row {
  key: string
  time: string
  icon: string
  label: string
  tone: 'default' | 'ok' | 'warn' | 'error'
}

/** Human labels for each event type (path-aware where resolvable). */
function describeEvent(event: WireHistoryEvent, pathByChange: Map<string, string>): Omit<Row, 'key' | 'time'> {
  const path = event.changeId !== undefined ? pathByChange.get(event.changeId) : undefined
  const where = path !== undefined ? ` ${path}` : ''
  const actor = event.actor === 'agent' ? 'Agent' : event.actor === 'user' ? '用户' : '系统'
  const base: Omit<Row, 'key' | 'time'> = { icon: '●', label: '', tone: 'default' }
  switch (event.type) {
    case 'created':
      return { ...base, icon: '＋', label: `${actor} 修改${where}`, tone: 'ok' }
    case 'approved':
      return { ...base, icon: '✓', label: `接受${where}`, tone: 'ok' }
    case 'applied':
      return { ...base, icon: '✓', label: `${actor} 应用${where}`, tone: 'ok' }
    case 'rejected':
      return { ...base, icon: '×', label: `拒绝${where}`, tone: 'warn' }
    case 'rolled_back':
      return { ...base, icon: '↶', label: `回滚${where}`, tone: 'warn' }
    case 'reviewed':
      return { ...base, icon: '◎', label: 'Review 完成' }
    case 'verified':
      return { ...base, icon: '◇', label: '验证通过', tone: 'ok' }
    case 'committed':
      return { ...base, icon: '◆', label: '已提交' }
    default:
      return { ...base, label: `${actor} ${event.type}` }
  }
}

/** The session timeline: newest last, oldest first (chronological). */
export function TimelineView(props: TimelineViewProps): ReactElement {
  const { events, changes, limit } = props
  const pathByChange = useMemo(() => {
    const map = new Map<string, string>()
    for (const change of changes) map.set(change.id, relativePath(change))
    return map
  }, [changes])

  const rows = useMemo(() => {
    const all = [...events].sort((a, b) => a.timestamp - b.timestamp)
    const sliced = limit !== undefined ? all.slice(-limit) : all
    return sliced.map(event => ({
      ...describeEvent(event, pathByChange),
      key: event.id,
      time: timeOf(event.timestamp),
    }))
  }, [events, pathByChange, limit])

  if (rows.length === 0) {
    return createElement('div', { className: css.empty }, '暂无事件')
  }

  return createElement('ol', { className: css.timeline },
    rows.map(row => createElement('li', {
      key: row.key,
      className: css.row,
      'data-tone': row.tone,
    },
    createElement('span', { className: css.time }, row.time),
    createElement('span', { className: css.icon }, row.icon),
    createElement('span', { className: css.label }, row.label),
    )),
  )
}

function timeOf(timestamp: number): string {
  const date = new Date(timestamp)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

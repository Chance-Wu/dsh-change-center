/**
 * Session header: name, status badge, and change statistics for one
 * change session. 对齐 Harness 设计 token。
 * @module dsh-change-center/client
 */

import { createElement, type ReactElement } from 'react'
import type { WireSession } from './index.ts'
import css from './SessionHeader.module.css'

/** Props for the session header row. */
export interface SessionHeaderProps {
  session: WireSession
}

const STATUS_ZH: Record<string, string> = {
  active: '进行中',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
}

/** 状态 → 徽标样式类。 */
function statusClass(status: string): string {
  switch (status) {
    case 'active': return css.statusActive
    case 'completed': return css.statusCompleted
    case 'failed': return css.statusFailed
    default: return css.statusCancelled
  }
}

/** One session's summary header. */
export function SessionHeader(props: SessionHeaderProps): ReactElement {
  const { session } = props
  return createElement('div', { className: css.header },
    createElement('span', {
      className: css.title,
      // Turn 指代说明:一轮 = agent 一次完整回复周期内捕获的变更集合。
      title: '「Turn N」指 agent 第 N 轮回复周期内捕获的变更集合',
    }, session.name),
    createElement('span', { className: statusClass(session.status) }, STATUS_ZH[session.status] ?? session.status),
    createElement('span', { className: css.meta },
      `${shortId(session.agentSessionId)} · ${session.changeIds.length} 项变更`),
    createElement('span', { className: css.stats },
      createElement('span', { className: css.statsFiles }, `${session.statistics.files} 个文件`),
      session.statistics.additions > 0
        ? createElement('span', { className: css.statsAdd }, `+${session.statistics.additions}`)
        : null,
      session.statistics.deletions > 0
        ? createElement('span', { className: css.statsDel }, `-${session.statistics.deletions}`)
        : null,
    ),
  )
}

/** Last 6 chars of an agent session id (compact display, full in title). */
function shortId(id: string): string {
  return id.length > 6 ? id.slice(-6) : id
}

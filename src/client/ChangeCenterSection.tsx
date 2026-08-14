/**
 * Change Center settings section: session list on the left; selecting one
 * opens the shared {@link ChangeReviewPanel} on the right.
 *
 * Data arrives through the same-origin `/api/change-center` routes; the
 * section polls on mount and after every action. 样式对齐 Harness 设计 token
 *（深色主题自动适配），选中行用品牌蓝高亮。
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

/**
 * The settings-surface review: sessions on the left, one session's review
 * panel on the right.
 */
export function ChangeCenterSection(props: ChangeCenterSectionProps): ReactElement {
  const { api } = props
  const [sessions, setSessions] = useState<WireSession[]>([])
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshSessions = (): void => {
    api.listSessions()
      .then(list => {
        setSessions(list)
        if (selectedSession === null && list.length > 0) setSelectedSession(list[0]!.id)
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(() => {
    refreshSessions()
    // 事件驱动:host 推送变更/会话事件时自动刷新列表(与 ChangesTab 一致)。
    return api.subscribeEvents(() => refreshSessions())
  }, [])

  const session = sessions.find(s => s.id === selectedSession) ?? null

  return createElement('div', { className: css.section },
    createElement('div', { className: css.header }, '变更中心'),
    // 流程引导:捕获 → 审查 → 应用 → 回滚。
    createElement('div', { className: css.guide },
      '变更流程:捕获(agent 修改文件) → 审查(逐条接受/拒绝) → 应用(写回工作区) → 回滚(撤销已应用变更)'),
    error !== null ? createElement('div', { className: css.error }, error) : null,
    createElement('div', { className: css.layout },
      // Left: session list.
      createElement('div', { className: css.sessionList },
        sessions.length === 0
          ? createElement('div', { className: css.muted },
            '暂无变更会话。',
            createElement('br'),
            '让 agent 修改文件后,这里会出现按轮次(Turn)分组的变更。')
          : sessions.map(s => createElement('button', {
            key: s.id,
            className: css.sessionRow,
            'data-selected': selectedSession === s.id,
            onClick: () => setSelectedSession(s.id),
          },
          createElement('span', { className: css.sessionName }, s.name),
          createElement('span', { className: css.sessionMeta },
            `${s.statistics.files} 个文件 · +${s.statistics.additions} -${s.statistics.deletions}`),
          )),
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
            api,
            onChanged: refreshSessions,
          }),
        ),
    ),
  )
}

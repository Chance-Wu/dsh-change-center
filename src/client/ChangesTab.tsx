/**
 * Conversation Changes tab: the shared review surface for the CURRENT
 * conversation's agent session, rendered as a `conversation.view` tab
 * alongside Chat and Trajectory.
 *
 * The tab receives the agent session id via the slot's inject; it maps that
 * to the change session whose `agentSessionId` matches, then renders the
 * shared {@link ChangeReviewPanel}.
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useState, type ReactElement } from 'react'
import type { ChangeCenterApi, WireSession } from './index.ts'
import { ChangeReviewPanel } from './ChangeReviewPanel.tsx'
import css from './ChangesTab.module.css'

/** Injected props: the agent session id for the conversation this tab shows. */
export interface ChangesTabInjected {
  sessionId: string
}

/** Props for the changes tab. */
export interface ChangesTabProps extends ChangesTabInjected {
  api: ChangeCenterApi
}

/** The conversation-view tab body. */
export function ChangesTab(props: ChangesTabProps): ReactElement {
  const { sessionId, api } = props
  const [session, setSession] = useState<WireSession | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    api.listSessions()
      .then(list => {
        // 同一 agent 会话多次 turn 会生成多个 change session（agentSessionId
        // 相同）；取最近更新（updatedAt 最大）的那个，避免匹配到旧空会话。
        const matches = list
          .filter(s => s.agentSessionId === sessionId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
        setSession(matches[0] ?? null)
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(() => {
    refresh()
    // 事件驱动：host 推送 change/job 事件时自动刷新，无需轮询。
    return api.subscribeEvents(() => refresh())
  }, [sessionId])

  if (error !== null) {
    return createElement('div', { className: css.tab },
      createElement('p', { className: css.error }, error))
  }
  if (session === null) {
    return createElement('div', { className: css.tab },
      createElement('div', { className: css.empty },
        createElement('div', { className: css.emptyText },
          '本会话暂无捕获的变更。',
          createElement('br'),
          '让 agent 修改文件后，变更会自动出现在这里。'),
      ),
    )
  }
  return createElement('div', { className: css.tab },
    createElement(ChangeReviewPanel, {
      sessionId: session.id,
      name: session.name,
      status: session.status,
      agentSessionId: session.agentSessionId,
      workspace: session.workspace,
      statistics: session.statistics,
      api,
      onChanged: refresh,
    }),
  )
}

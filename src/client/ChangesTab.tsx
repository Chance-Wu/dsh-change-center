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
    // 轮询：agent 运行期间新捕获的变更自动出现，无需手动切换标签页。
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [sessionId])

  if (error !== null) {
    return createElement('div', { style: tabStyle },
      createElement('p', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, error))
  }
  if (session === null) {
    return createElement('div', { style: tabStyle },
      createElement('div', { style: emptyStyle },
        createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', textAlign: 'center', lineHeight: 1.6 } },
          '本会话暂无捕获的变更。',
          createElement('br'),
          '让 agent 修改文件后，变更会自动出现在这里。'),
      ),
    )
  }
  return createElement('div', { style: tabStyle },
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

const tabStyle: Record<string, string | number> = {
  height: '100%',
  minHeight: 0,
  overflow: 'auto',
}
const emptyStyle: Record<string, string | number> = {
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px',
}

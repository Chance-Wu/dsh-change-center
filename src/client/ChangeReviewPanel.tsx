/**
 * Change review panel: the shared review surface for ONE change session —
 * file tree on the left, diff viewer + review bar in the center, and the
 * intelligence column (git/review/risk/verification/policy) on the right.
 * on the right. Used both by the settings Change Center section and the
 * conversation Changes tab.
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useState, type ReactElement } from 'react'
import type { ChangeCenterApi, WireChange } from './index.ts'
import { ChangeTree } from './ChangeTree.tsx'
import { DiffViewer } from './DiffViewer.tsx'
import { ReviewBar } from './ReviewBar.tsx'
import { SessionHeader } from './SessionHeader.tsx'
import { IntelligencePanel } from './IntelligencePanel.tsx'
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
  const { sessionId, name, status, agentSessionId, workspace, statistics, api, onChanged } = props
  const [changes, setChanges] = useState<WireChange[]>([])
  const [selectedChange, setSelectedChange] = useState<string | null>(null)
  const [diffMode, setDiffMode] = useState<'unified' | 'side-by-side' | 'editor'>('unified')
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    api.sessionChanges(sessionId)
      .then(list => {
        setChanges(list)
        // Keep the selection when it still exists; otherwise pick the first
        // reviewable file change (command records are not selectable).
        setSelectedChange(prev => {
          if (prev !== null && list.some(c => c.id === prev)) return prev
          return list.find(isReviewableChange)?.id ?? null
        })
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(() => {
    refresh()
  }, [sessionId])

  const afterAction = (): void => {
    refresh()
    onChanged?.()
  }

  // 只审查真实文件变更：命令执行等「没有变更」的记录不进入文件树与 diff。
  const fileChanges = changes.filter(isReviewableChange)
  const change = fileChanges.find(c => c.id === selectedChange) ?? null

  return createElement('div', { className: css.panel },
    error !== null ? createElement('p', { className: css.error }, error) : null,
    createElement(SessionHeader, {
      session: {
        id: sessionId, name, status, agentSessionId, workspace, changeIds: fileChanges.map(c => c.id), statistics,
        createdAt: 0, updatedAt: 0,
      },
    }),
    createElement('div', { className: css.body },
      createElement(ChangeTree, {
        changes: fileChanges,
        selected: selectedChange,
        onSelect: setSelectedChange,
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
            onSaved: (after) => {
              api.editChange(change.id, after)
                .then(afterAction)
                .catch(err => setError(err instanceof Error ? err.message : String(err)))
            },
          }),
          createElement(ReviewBar, {
            change,
            api,
            onAction: afterAction,
            onError: (message) => setError(message),
          }),
        ),
      createElement(IntelligencePanel, {
        sessionId,
        workspace,
        api,
        onChanged: afterAction,
      }),
    ),
  )
}

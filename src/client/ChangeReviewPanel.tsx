/**
 * Change review panel: the shared review surface for ONE change session —
 * file tree on the left, diff viewer + review bar in the center, and the
 * intelligence column (git/review/risk/verification/policy) on the right.
 * Used both by the settings Change Center section and the conversation
 * Changes tab.
 *
 * The header action bar hosts the session-level 「全部接收并应用」 operation
 * (approve every pending change and apply it) with a result summary, and the
 * tree receives approve/reject quick-action callbacks.
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { ChangeCenterApi, WireAcceptAllResult, WireChange } from './index.ts'
import { ChangeTree, dedupeByPath } from './ChangeTree.tsx'
import { countDiff } from '../services/DiffService.ts'
import { DiffViewer } from './DiffViewer.tsx'
import { ReviewBar } from './ReviewBar.tsx'
import { SessionHeader } from './SessionHeader.tsx'
import { IntelligencePanel } from './IntelligencePanel.tsx'
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
  const [busy, setBusy] = useState(false)
  const [acceptResult, setAcceptResult] = useState<WireAcceptAllResult | null>(null)
  const [acceptError, setAcceptError] = useState<string | null>(null)

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

  /** Tree quick actions + the review bar share one action path. */
  const quickAction = (id: string, action: 'approve' | 'reject'): void => {
    api.changeAction(id, action)
      .then(afterAction)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }

  const acceptAllAndApply = (): void => {
    setBusy(true)
    setAcceptError(null)
    api.acceptAllAndApply(sessionId)
      .then(result => { setAcceptResult(result); afterAction() })
      .catch(err => setAcceptError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  // 只审查真实文件变更：命令执行等「没有变更」的记录不进入文件树与 diff；
  // 同一文件的多次写入只保留最新一次（按路径去重）。
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
  const failedCount = acceptResult?.failed.length ?? 0

  return createElement('div', { className: css.panel },
    error !== null ? createElement('p', { className: css.error }, error) : null,
    createElement(SessionHeader, {
      session: {
        id: sessionId, name, status, agentSessionId, workspace, changeIds: fileChanges.map(c => c.id), statistics: displayStats,
        createdAt: 0, updatedAt: 0,
      },
    }),
    // Session-level action bar: pending badge + 全部接收并应用 + result summary.
    createElement('div', { className: css.actionBar },
      pendingCount > 0
        ? createElement('span', { className: css.pendingBadge }, `${pendingCount} 项变更待审查`)
        : createElement('span', { className: css.pendingNone }, '无待审查变更'),
      createElement('button', {
        onClick: acceptAllAndApply,
        disabled: busy || pendingCount === 0,
        className: baseCss.buttonPrimary,
      }, busy ? '处理中…' : '全部接收并应用'),
      acceptError !== null
        ? createElement('span', { className: css.acceptError }, acceptError)
        : null,
      acceptResult !== null
        ? createElement('div', { className: css.resultSummary },
          createElement('div', { className: css.resultHead },
            createElement('span', { className: css.resultOk }, `已应用 ${acceptResult.applied.length}`),
            failedCount > 0
              ? createElement('span', { className: css.resultFail }, `失败 ${failedCount}`)
              : null,
            acceptResult.skipped.length > 0 || acceptResult.superseded.length > 0
              ? createElement('span', { className: css.resultMuted },
                `跳过 ${acceptResult.skipped.length}${acceptResult.superseded.length > 0 ? ` · 旧写入 ${acceptResult.superseded.length}` : ''}`)
              : null,
            createElement('button', { onClick: () => setAcceptResult(null), className: css.resultClose }, '×'),
          ),
          acceptResult.failed.length > 0
            ? createElement('ul', { className: css.resultFailList },
              acceptResult.failed.map(item => createElement('li', { key: item.id },
                createElement('span', { className: css.resultFailId }, item.id),
                createElement('span', null, item.message),
              )),
            )
            : null,
        )
        : null,
    ),
    createElement('div', { className: css.body },
      createElement(ChangeTree, {
        changes: fileChanges,
        selected: selectedChange,
        onSelect: setSelectedChange,
        onApprove: (id) => quickAction(id, 'approve'),
        onReject: (id) => quickAction(id, 'reject'),
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
            // 批量「全部接收并应用」进行中,禁用单条操作避免竞态。
            disabled: busy,
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

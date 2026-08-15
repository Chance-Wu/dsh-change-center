/**
 * Diff viewer with three modes: unified (`-old`/`+new` lines), side-by-side
 * (before | after columns), and editor (textarea editing the after text).
 *
 * Line alignment reuses the shared LCS diff; edits save through the API and
 * reset the change to pending. The editor draft is CONTROLLED by the review
 * panel (Vibe UI V-7): the panel owns `draft`, so it can guard file/session
 * switches with 保存 / 放弃 / 取消 and guarantee that Apply always runs on the
 * version the user actually sees — never silently on the stale AI version.
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { WireChange } from './index.ts'
import type { SideBySideRow } from '../services/DiffService.ts'
import { countDiff } from '../services/DiffService.ts'
import { statusMeta } from './statusMeta.ts'
import css from './DiffViewer.module.css'
import baseCss from './styles.module.css'

/** Props for the diff viewer. */
export interface DiffViewerProps {
  change: WireChange
  mode: 'unified' | 'side-by-side' | 'editor'
  onModeChange: (mode: 'unified' | 'side-by-side' | 'editor') => void
  onSaved: (after: string) => void
  /** Panel lock (bulk op in flight / result showing): disable saving edits. */
  disabled?: boolean
  /**
   * Controlled editor draft (V-7): the review panel owns the textarea value.
   * When omitted the viewer falls back to its own local copy.
   */
  draft?: string
  onDraftChange?: (draft: string) => void
  /** Reports whether the draft differs from the applied/committed after text. */
  onDirtyChange?: (dirty: boolean) => void
}

/**
 * Diff renderer. The client bundle is a single file with no runtime module
 * table entries for the diff service, so the row alignment is re-implemented
 * here (same LCS semantics) rather than imported.
 */
export function DiffViewer(props: DiffViewerProps): ReactElement {
  const { change, mode, onModeChange, onSaved, disabled = false } = props
  const rows: SideBySideRow[] = useMemo(() => alignRows(change.before, change.after), [change.before, change.after])
  const counts = useMemo(() => countDiff(change.before, change.after), [change.before, change.after])
  const meta = statusMeta(change.status)

  // Fallback local copy for callers that do not control the draft.
  const [localDraft, setLocalDraft] = useState(change.after ?? '')
  useEffect(() => {
    setLocalDraft(change.after ?? '')
  }, [change.id, change.after])

  const draft = props.draft ?? localDraft
  const setDraft = (next: string): void => {
    props.onDraftChange?.(next)
    setLocalDraft(next)
  }
  const dirty = draft !== (change.after ?? '')

  // 保存反馈:乐观提示「✓ 已保存」1.5 秒(失败由面板错误区呈现)。
  const [justSaved, setJustSaved] = useState(false)
  useEffect(() => {
    if (!justSaved) return
    const timer = setTimeout(() => setJustSaved(false), 1500)
    return () => clearTimeout(timer)
  }, [justSaved])

  // 脏状态上报:父级据此守卫文件/会话切换与批量操作。
  useEffect(() => {
    props.onDirtyChange?.(dirty)
  }, [dirty])

  const save = (): void => {
    if (!dirty) return
    setJustSaved(true)
    onSaved(draft)
  }

  const discard = (): void => {
    setDraft(change.after ?? '')
  }

  return createElement('div', { className: css.viewer },
    createElement('div', { className: css.toolbar },
      createElement('div', { className: css.fileBlock },
        createElement('span', { className: css.fileTitle, title: change.path }, change.path.split('/').pop()),
        // 3.0.9:脏状态弱视觉 —— 文件名旁一个小圆点,不打扰。
        dirty ? createElement('span', { className: css.dirtyDot, title: '未保存的修改' }, '●') : null,
        // P-1:文件头 +N -M 一目了然。
        createElement('span', { className: css.fileCounts },
          counts.additions > 0 ? createElement('span', { className: css.countAdd }, `+${counts.additions}`) : null,
          counts.deletions > 0 ? createElement('span', { className: css.countDel }, `-${counts.deletions}`) : null,
        ),
        // 3.0.8:状态徽标(actionsFor/状态模型驱动,UI 不自判)。
        createElement('span', {
          className: css.statusBadge,
          title: meta.label,
          'data-weight': meta.weight,
        }, `${meta.icon} ${meta.label}`),
      ),
      createElement('div', { className: css.modeTabs },
        modeTab('统一', mode === 'unified', () => onModeChange('unified')),
        modeTab('并排', mode === 'side-by-side', () => onModeChange('side-by-side')),
        modeTab('编辑', mode === 'editor', () => onModeChange('editor')),
      ),
    ),
    createElement('div', { className: css.content },
      mode === 'unified' && createElement(UnifiedView, { change }),
      mode === 'side-by-side' && createElement(SideBySideView, { rows }),
      mode === 'editor' && createElement('div', { className: css.editorArea },
        createElement('textarea', {
          value: draft,
          onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
          className: css.editorTextarea,
          spellCheck: false,
        }),
        createElement('div', { className: css.editorActions },
          // 3.0.9:弱视觉 —— 脏状态由文件名旁的小圆点表达,这里只保留动作。
          justSaved
            ? createElement('span', { className: css.savedHint }, '✓ 已保存')
            : null,
          dirty
            ? createElement('button', { onClick: discard, disabled, className: baseCss.buttonGhost }, '放弃')
            : null,
          createElement('button', { onClick: save, disabled: disabled || !dirty, className: baseCss.buttonPrimary }, '保存修改'),
        ),
      ),
    ),
  )
}

function modeTab(label: string, active: boolean, onClick: () => void): ReactElement {
  return createElement('button', {
    onClick,
    className: css.modeTab,
    'data-active': active,
  }, label)
}

/** Unified diff: one line per annotated diff row. */
function UnifiedView(props: { change: WireChange }): ReactElement {
  const { change } = props
  const lines = diffTextLines(change.diff)
  return createElement('div', { className: css.diffBody },
    lines.map((line, index) => {
      const kind = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context'
      return createElement('span', {
        key: index,
        className: kind === 'added' ? css.diffLineAdded
          : kind === 'removed' ? css.diffLineRemoved
            : css.diffLineContext,
        style: { display: 'block', padding: '0 8px' },
      }, line)
    }),
    lines.length === 0 ? createElement('div', { className: css.diffNoChange }, '(无变更)') : null,
  )
}

/** Split a unified diff string into lines, preserving -/+ prefixes. */
function diffTextLines(diff: string): string[] {
  const normalized = diff.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Side-by-side: two columns, deletions on the left, insertions on the right. */
function SideBySideView(props: { rows: SideBySideRow[] }): ReactElement {
  const { rows } = props
  return createElement('div', { className: css.sideBySide },
    createElement('div', { className: css.sideHeader },
      createElement('div', { className: css.sideColHeader }, '修改前'),
      createElement('div', { className: css.sideColHeader }, '修改后'),
    ),
    rows.map((row, index) => createElement('div', {
      key: index,
      className: [
        css.sideRow,
        row.deletion ? css.sideRowDeletion : row.insertion ? css.sideRowInsertion : undefined,
      ].filter(Boolean).join(' '),
    },
    createElement('div', { className: css.sideCol },
      row.deletion || !row.insertion ? createElement('span', { className: css.sideColDelText }, row.before ?? '') : null,
    ),
    createElement('div', { className: css.sideCol },
      row.insertion || !row.deletion ? createElement('span', { className: css.sideColInsText }, row.after ?? '') : null,
    ),
    )),
  )
}

/** Re-derive aligned rows with the same LCS semantics as DiffService. */
function alignRows(before: string | null, after: string | null): SideBySideRow[] {
  const a = splitLines(before)
  const b = splitLines(after)
  const lcs = lcsIndices(a, b)
  const out: SideBySideRow[] = []
  let i = 0
  let j = 0
  for (const item of lcs) {
    while (i < item.a) { out.push({ insertion: false, deletion: true, before: a[i] }); i++ }
    while (j < item.b) { out.push({ insertion: true, deletion: false, after: b[j] }); j++ }
    out.push({ insertion: false, deletion: false, before: a[i], after: a[i] })
    i++
    j++
  }
  while (i < a.length) { out.push({ insertion: false, deletion: true, before: a[i] }); i++ }
  while (j < b.length) { out.push({ insertion: true, deletion: false, after: b[j] }); j++ }
  return out
}

function splitLines(text: string | null): string[] {
  if (text === null) return []
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  // A trailing newline is a line terminator, not an empty final line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function lcsIndices(a: string[], b: string[]): { a: number; b: number }[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: { a: number; b: number }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ a: i, b: j })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return out
}

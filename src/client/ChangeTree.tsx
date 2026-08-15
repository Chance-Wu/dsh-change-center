/**
 * Change tree: the review surface's file list with two display modes —
 * 「按扩展名」(default, groups merged as `*.ext`) and 「目录树」(nested
 * directories, collapsible). Paths are shown relative to the change's
 * workspace; rows carry A/M/D markers, ±line counts, and hover quick actions
 * (接受/拒绝) for pending changes.
 *
 * The tree receives ALREADY-filtered file changes (see
 * {@link ChangeReviewPanel.isReviewableChange}) — command executions are not
 * reviewable changes and never reach this surface.
 * @module dsh-change-center/client
 */

import { createElement, useMemo, useState, type ReactElement } from 'react'
import type { WireChange } from './index.ts'
import { actionsFor } from './changeActions.ts'
import { countDiff } from '../services/DiffService.ts'
import { OPERATION_MARK } from './i18n.ts'
import css from './ChangeTree.module.css'

/** Props for the change tree. */
export interface ChangeTreeProps {
  changes: WireChange[]
  selected: string | null
  onSelect: (id: string) => void
  /** Quick approve from a tree row (pending changes only). */
  onApprove?: (id: string) => void
  /** Quick reject from a tree row (pending/approved/failed). */
  onReject?: (id: string) => void
  /** Quick re-pend from a tree row (rejected/rolled_back). */
  onRepend?: (id: string) => void
  /** Panel lock (bulk op in flight / result showing): hide quick actions. */
  disabled?: boolean
}

/** Display mode: extension groups (`*.ext`) or the directory tree. */
type TreeMode = 'ext' | 'dir'

/** Mark → CSS class (create/modify/delete). */
function markClass(operation: string): string {
  switch (operation) {
    case 'create': return css.markCreate
    case 'modify': return css.markModify
    case 'delete': return css.markDelete
    default: return css.markNeutral
  }
}

/** Path relative to the change's workspace; absolute/outside paths verbatim. */
export function relativePath(change: { path: string; cwd: string }): string {
  const base = (change.cwd ?? '').replace(/\/+$/, '')
  if (base.length > 0 && change.path.startsWith(`${base}/`)) {
    return change.path.slice(base.length + 1)
  }
  return change.path
}

/**
 * Deduplicate changes by path, keeping the FIRST occurrence. The list is
 * newest-first (createdAt desc), so the latest change for a path wins and
 * superseded writes to the same file disappear from the review surface.
 */
export function dedupeByPath(changes: WireChange[]): WireChange[] {
  const seen = new Set<string>()
  const out: WireChange[] = []
  for (const change of changes) {
    if (seen.has(change.path)) continue
    seen.add(change.path)
    out.push(change)
  }
  return out
}

/** Extension of a file path ('' for none); the `.` must not start the name. */
export function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

/** One extension group: merged files plus aggregate line counts. */
export interface ExtGroup {
  label: string
  changes: WireChange[]
  additions: number
  deletions: number
}

/** Group changes by file extension, labels as `*.ext` (or `(其他)`). */
export function groupByExtension(changes: WireChange[]): ExtGroup[] {
  const map = new Map<string, ExtGroup>()
  for (const change of changes) {
    const ext = extensionOf(change.path)
    const key = ext.length > 0 ? ext : '(other)'
    let group = map.get(key)
    if (group === undefined) {
      group = { label: ext.length > 0 ? `*.${ext}` : '(其他)', changes: [], additions: 0, deletions: 0 }
      map.set(key, group)
    }
    group.changes.push(change)
    const counts = countDiff(change.before, change.after)
    group.additions += counts.additions
    group.deletions += counts.deletions
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** Build a nested directory tree from workspace-relative file paths. */
interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  change: WireChange | null
  /** Aggregate file count / line counts under this node (incl. files). */
  files: number
  additions: number
  deletions: number
}

function buildTree(changes: WireChange[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), change: null, files: 0, additions: 0, deletions: 0 }
  for (const change of changes) {
    const segments = relativePath(change).split('/')
    let node = root
    let current = ''
    for (const segment of segments.slice(0, -1)) {
      current = current.length > 0 ? `${current}/${segment}` : segment
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { name: segment, path: current, children: new Map(), change: null, files: 0, additions: 0, deletions: 0 }
        node.children.set(segment, child)
      }
      node = child
    }
    const fileName = segments[segments.length - 1] ?? relativePath(change)
    const leafPath = current.length > 0 ? `${current}/${fileName}` : fileName
    const counts = countDiff(change.before, change.after)
    node.children.set(fileName, {
      name: fileName,
      path: leafPath,
      children: new Map(),
      change,
      files: 1,
      additions: counts.additions,
      deletions: counts.deletions,
    })
    // Roll the leaf's stats up to every ancestor directory.
    let ancestor: TreeNode = root
    for (const segment of segments.slice(0, -1)) {
      ancestor = ancestor.children.get(segment) as TreeNode
      ancestor.files += 1
      ancestor.additions += counts.additions
      ancestor.deletions += counts.deletions
    }
  }
  return root
}

/** Clean disclosure chevron (rotates 90° when a directory is expanded). */
function Chevron(props: { collapsed: boolean }): ReactElement {
  return createElement('svg', {
    className: props.collapsed ? css.chevronCollapsed : css.chevronExpanded,
    viewBox: '0 0 16 16',
    width: 12,
    height: 12,
    'aria-hidden': true,
  },
  createElement('path', {
    d: 'M6 4l4 4-4 4',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }))
}

/** One file row: mark + relative path + counts + hover quick actions. */
function renderFileRow(
  change: WireChange,
  props: ChangeTreeProps,
  depth: number,
): ReactElement {
  const mark = OPERATION_MARK[change.operation] ?? '?'
  const counts = countDiff(change.before, change.after)
  // 快速操作与操作栏共用同一矩阵(actionsFor),面板锁定时隐藏。
  const actions = actionsFor(change.status)
  const showActions = !(props.disabled ?? false)
  return createElement('button', {
    key: change.id,
    className: css.fileRow,
    'data-selected': props.selected === change.id,
    onClick: () => props.onSelect(change.id),
    style: { paddingLeft: 6 + depth * 14 + 14 },
  },
  createElement('span', { className: markClass(change.operation) }, mark),
  createElement('span', { className: css.fileName }, relativePath(change)),
  counts.additions + counts.deletions > 0
    ? createElement('span', { className: css.counts },
      counts.additions > 0 ? createElement('span', { className: css.countAdd }, `+${counts.additions}`) : null,
      counts.deletions > 0 ? createElement('span', { className: css.countDel }, `-${counts.deletions}`) : null,
    )
    : null,
  showActions && (actions.canApprove || actions.canReject || actions.canRepend)
    ? createElement('span', { className: css.rowActions, onClick: (event: MouseEvent) => event.stopPropagation() },
      actions.canApprove && props.onApprove !== undefined
        ? createElement('button', { className: css.actionApprove, onClick: () => props.onApprove?.(change.id) }, '接受')
        : null,
      actions.canReject && props.onReject !== undefined
        ? createElement('button', { className: css.actionReject, onClick: () => props.onReject?.(change.id) }, '拒绝')
        : null,
      actions.canRepend && props.onRepend !== undefined
        ? createElement('button', { className: css.actionApprove, onClick: () => props.onRepend?.(change.id) }, '重新处理')
        : null,
    )
    : null,
  )
}

/** Render one directory node recursively (sorted: dirs first, then files). */
function renderNode(
  node: TreeNode,
  depth: number,
  props: ChangeTreeProps,
  collapsed: ReadonlySet<string>,
  onToggle: (path: string) => void,
): ReactElement[] {
  const dirs = [...node.children.values()].filter(child => child.change === null)
    .sort((a, b) => a.name.localeCompare(b.name))
  const files = [...node.children.values()].filter(child => child.change !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
  const out: ReactElement[] = []
  for (const dir of dirs) {
    const isCollapsed = collapsed.has(dir.path)
    out.push(createElement('button', {
      key: `dir-${dir.path}`,
      className: css.dirRow,
      style: { paddingLeft: 6 + depth * 14 },
      onClick: () => onToggle(dir.path),
      title: isCollapsed ? '展开目录' : '折叠目录',
    },
    createElement(Chevron, { collapsed: isCollapsed }),
    createElement('span', { className: css.dirName }, dir.name),
    createElement('span', { className: css.dirStats },
      `${dir.files} · +${dir.additions} -${dir.deletions}`),
    ))
    if (!isCollapsed) {
      out.push(...renderNode(dir, depth + 1, props, collapsed, onToggle))
    }
  }
  for (const file of files) {
    out.push(renderFileRow(file.change as WireChange, props, depth))
  }
  return out
}

/** The file list for a session's changes (directory tree by default). */
export function ChangeTree(props: ChangeTreeProps): ReactElement {
  const [mode, setMode] = useState<TreeMode>('dir')
  const groups = useMemo(() => groupByExtension(props.changes), [props.changes])
  const root = useMemo(() => buildTree(props.changes), [props.changes])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const toggle = (path: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const setAllCollapsed = (collapse: boolean): void => {
    setCollapsed(collapse ? new Set(allDirPaths(root)) : new Set())
  }

  return createElement('div', { className: css.tree },
    createElement('div', { className: css.title },
      createElement('span', null, '变更'),
      createElement('span', { className: css.titleCount }, props.changes.length),
      createElement('span', { className: css.modeToggle },
        createElement('button', {
          className: mode === 'ext' ? css.modeBtnActive : css.modeBtn,
          onClick: () => setMode('ext'),
        }, '*.ext'),
        createElement('button', {
          className: mode === 'dir' ? css.modeBtnActive : css.modeBtn,
          onClick: () => setMode('dir'),
        }, '目录'),
      ),
    ),
    props.changes.length === 0
      ? createElement('div', { className: css.empty }, '暂无文件变更')
      : mode === 'ext'
        ? groups.map(group => createElement('div', { key: group.label, className: css.extGroup },
          createElement('div', { className: css.groupHeader },
            createElement('span', { className: css.groupLabel }, group.label),
            createElement('span', { className: css.groupStats },
              `${group.changes.length} 个 · +${group.additions} -${group.deletions}`),
          ),
          group.changes.map(change => renderFileRow(change, props, 0)),
        ))
        : createElement('div', { className: css.dirArea },
          createElement('div', { className: css.dirToolbar },
            createElement('button', { className: css.modeBtn, onClick: () => setAllCollapsed(true) }, '全部折叠'),
            createElement('button', { className: css.modeBtn, onClick: () => setAllCollapsed(false) }, '全部展开'),
          ),
          renderNode(root, 0, props, collapsed, toggle),
        ),
  )
}

/** Collect every directory path under a tree node (for collapse-all). */
function allDirPaths(node: TreeNode): string[] {
  const out: string[] = []
  for (const child of node.children.values()) {
    if (child.change === null) {
      out.push(child.path, ...allDirPaths(child))
    }
  }
  return out
}

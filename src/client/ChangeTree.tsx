/**
 * Change tree: one row per changed file with an A/M/D marker, grouped by
 * directory segments. Directories are collapsible; selecting a file only
 * opens its diff inline (never an external application).
 *
 * The tree receives ALREADY-filtered file changes (see
 * {@link ChangeReviewPanel.isReviewableChange}) — command executions are not
 * reviewable changes and never reach this surface.
 * @module dsh-change-center/client
 */

import { createElement, useMemo, useState, type ReactElement } from 'react'
import type { WireChange } from './index.ts'
import { countDiff } from '../services/DiffService.ts'
import { OPERATION_MARK } from './i18n.ts'
import css from './ChangeTree.module.css'

/** Props for the change tree. */
export interface ChangeTreeProps {
  changes: WireChange[]
  selected: string | null
  onSelect: (id: string) => void
}

/** Mark → CSS class (create/modify/delete). */
function markClass(operation: string): string {
  switch (operation) {
    case 'create': return css.markCreate
    case 'modify': return css.markModify
    case 'delete': return css.markDelete
    default: return css.markNeutral
  }
}

/** Build a nested directory tree from flat file paths. */
interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  change: WireChange | null
}

function buildTree(changes: WireChange[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), change: null }
  for (const change of changes) {
    const segments = change.path.split('/')
    let node = root
    let current = ''
    for (const segment of segments.slice(0, -1)) {
      current = current.length > 0 ? `${current}/${segment}` : segment
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { name: segment, path: current, children: new Map(), change: null }
        node.children.set(segment, child)
      }
      node = child
    }
    const fileName = segments[segments.length - 1] ?? change.path
    const leafPath = current.length > 0 ? `${current}/${fileName}` : fileName
    node.children.set(fileName, { name: fileName, path: leafPath, children: new Map(), change })
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
    ))
    if (!isCollapsed) {
      out.push(...renderNode(dir, depth + 1, props, collapsed, onToggle))
    }
  }
  for (const file of files) {
    const change = file.change as WireChange
    const mark = OPERATION_MARK[change.operation] ?? '?'
    const counts = countDiff(change.before, change.after)
    // 只内联选中显示 diff，绝不打开外部应用（无 openPath/openFile 调用）。
    out.push(createElement('button', {
      key: change.id,
      className: css.fileRow,
      'data-selected': props.selected === change.id,
      onClick: () => props.onSelect(change.id),
      style: { paddingLeft: 6 + depth * 14 + 14 },
    },
    createElement('span', { className: markClass(change.operation) }, mark),
    createElement('span', { className: css.fileName }, change.path.split('/').pop()),
    counts.additions + counts.deletions > 0
      ? createElement('span', { className: css.counts },
        counts.additions > 0 ? createElement('span', { className: css.countAdd }, `+${counts.additions}`) : null,
        counts.deletions > 0 ? createElement('span', { className: css.countDel }, `-${counts.deletions}`) : null,
      )
      : null,
    ))
  }
  return out
}

/** The file tree for a session's changes. */
export function ChangeTree(props: ChangeTreeProps): ReactElement {
  const root = useMemo(() => buildTree(props.changes), [props.changes])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const toggle = (path: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  return createElement('div', { className: css.tree },
    createElement('div', { className: css.title },
      createElement('span', null, '变更'),
      createElement('span', { className: css.titleCount }, props.changes.length),
    ),
    props.changes.length === 0
      ? createElement('div', { className: css.empty }, '暂无文件变更')
      : renderNode(root, 0, props, collapsed, toggle),
  )
}

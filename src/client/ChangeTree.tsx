/**
 * Change tree: the review surface's file list with two display modes —
 * 「按扩展名」(default, groups merged as `*.ext`) and 「目录树」(nested
 * directories, collapsible). Paths are shown relative to the change's
 * workspace; rows carry A/M/D markers, ±line counts, and hover quick actions.
 *
 * 4.x Large Repository Mode: the directory tree renders as a FLATTENED,
 * windowed list (fixed row height + scroll window), so thousands of changes
 * stay smooth; search / operation / path-prefix filters narrow the surface.
 *
 * The tree receives ALREADY-filtered file changes (see
 * {@link ChangeReviewPanel.isReviewableChange}) — command executions are not
 * reviewable changes and never reach this surface.
 * @module dsh-change-center/client
 */

import { createElement, useMemo, useRef, useState, type ReactElement, type UIEvent } from 'react'
import type { WireChange } from './index.ts'
import { actionsFor, type ChangeActions } from './changeActions.ts'
import { statusMeta } from './statusMeta.ts'
import { countDiff } from '../services/DiffService.ts'
import { OPERATION_MARK } from './i18n.ts'
import css from './ChangeTree.module.css'

/** Props for the change tree. */
export interface ChangeTreeProps {
  changes: WireChange[]
  selected: string | null
  onSelect: (id: string) => void
  /** Quick rollback from a tree row (applied). */
  onRollback?: (id: string) => void
  /** Quick restore from a tree row (rolled_back) — 写回 agent 版本。 */
  onRestore?: (id: string) => void
  /** Panel lock (bulk op in flight / result showing): hide quick actions. */
  disabled?: boolean
  /** S-6:策略 deny 的变更 id 集合 → 行尾 ⛔ 徽标。 */
  deniedIds?: ReadonlySet<string>
  /** 数据加载中:显示骨架而非「暂无文件变更」。 */
  loading?: boolean
}

/** Display mode: extension groups (`*.ext`) or the directory tree. */
type TreeMode = 'ext' | 'dir'

/** 4.x:窗口化渲染的行高(与 CSS 保持一致)。 */
const ROW_HEIGHT = 30
/** 视口外预渲染行数。 */
const OVERSCAN = 8

/** 4.x 每文件风险等级:UI 层轻量启发,与 RiskService 规则同源(展示用)。 */
type FileRisk = 'low' | 'medium' | 'high'

function fileRisk(change: WireChange): FileRisk {
  if (change.operation === 'delete') return 'high'
  const p = change.path
  if (/securityconfig|permission|authorization|role|\.sql$/i.test(p)) return 'high'
  if (/pom\.xml$|package\.json$|build\.gradle(\.kts)?$|application\.ya?ml$|application\.properties$/i.test(p)) return 'medium'
  return 'low'
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

/** 5.x 双操作模型:每行唯一主操作(回滚 / 恢复)。 */
function primaryAction(actions: ChangeActions): 'rollback' | 'restore' | null {
  if (actions.canRollback) return 'rollback'
  if (actions.canReapply) return 'restore'
  return null
}

/** 风险 chip 渲染:低=不显示,中/高显示等级。 */
function riskChipFor(change: WireChange): ReactElement | null {
  const risk = fileRisk(change)
  if (risk === 'low') return null
  return createElement('span', {
    className: risk === 'high' ? css.riskHigh : css.riskMedium,
    title: risk === 'high' ? '高风险:删除或敏感路径' : '中风险:配置/依赖文件',
  }, risk === 'high' ? '高风险' : '中风险')
}

/** 快捷操作语义配色:回滚/恢复=中性。 */
function actionClass(kind: string): string {
  return css.actionGhost
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
  // V-8 状态视觉:非待审状态在行尾显示状态字形(失败突出、已应用成功、回滚弱化)。
  const meta = statusMeta(change.status)
  const statusGlyph = change.status === 'pending'
    ? null
    : createElement('span', {
      className: change.status === 'failed' ? css.statusFailed
        : change.status === 'applied' ? css.statusApplied
          : css.statusMuted,
      title: meta.label,
    }, meta.icon)
  // S-6:策略 deny 的变更显示 ⛔(优先级高于状态字形)。
  const denied = props.deniedIds?.has(change.id) ?? false
  // 每行唯一主操作(由 actionsFor 决定合法性)。
  const primary = primaryAction(actions)

  const stop = (handler: () => void) => (event: MouseEvent) => { event.stopPropagation(); handler() }
  const primaryButton = primary !== null
    ? createElement('button', {
      className: actionClass(primary),
      onClick: stop(() => {
        if (primary === 'rollback') props.onRollback?.(change.id)
        else if (primary === 'restore') props.onRestore?.(change.id)
      }),
    }, primary === 'rollback' ? '回滚' : '恢复')
    : null

  return createElement('button', {
    key: change.id,
    className: css.fileRow,
    'data-selected': props.selected === change.id,
    onClick: () => props.onSelect(change.id),
    style: { paddingLeft: 6 + depth * 14 + 14, height: ROW_HEIGHT },
  },
  createElement('span', { className: markClass(change.operation) }, mark),
  createElement('span', { className: css.fileName }, relativePath(change)),
  counts.additions + counts.deletions > 0
    ? createElement('span', { className: css.counts },
      counts.additions > 0 ? createElement('span', { className: css.countAdd }, `+${counts.additions}`) : null,
      counts.deletions > 0 ? createElement('span', { className: css.countDel }, `-${counts.deletions}`) : null,
    )
    : null,
  riskChipFor(change),
  denied
    ? createElement('span', { className: css.statusDenied, title: '被策略拒绝' }, '⊘')
    : statusGlyph,
  showActions && primary !== null
    ? createElement('span', { className: css.rowActions, onClick: (event: MouseEvent) => event.stopPropagation() },
      primaryButton,
    )
    : null,
  )
}

/** 4.x:扁平化的一行(目录或文件),供窗口化渲染。 */
interface FlatRow {
  key: string
  type: 'dir' | 'file'
  depth: number
  path: string
  name: string
  collapsed: boolean
  change?: WireChange
  dir?: { files: number; additions: number; deletions: number }
}

/** 递归展平目录树(折叠状态 + forceExpand)。 */
function flattenTree(
  node: TreeNode,
  depth: number,
  collapsed: ReadonlySet<string>,
  forceExpand: boolean,
  out: FlatRow[],
): void {
  const dirs = [...node.children.values()].filter(child => child.change === null)
    .sort((a, b) => a.name.localeCompare(b.name))
  const files = [...node.children.values()].filter(child => child.change !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const dir of dirs) {
    const isCollapsed = collapsed.has(dir.path)
    out.push({
      key: `dir-${dir.path}`,
      type: 'dir',
      depth,
      path: dir.path,
      name: dir.name,
      collapsed: isCollapsed,
      dir: { files: dir.files, additions: dir.additions, deletions: dir.deletions },
    })
    if (!isCollapsed || forceExpand) {
      flattenTree(dir, depth + 1, collapsed, forceExpand, out)
    }
  }
  for (const file of files) {
    out.push({
      key: file.change!.id,
      type: 'file',
      depth,
      path: file.path,
      name: file.name,
      collapsed: false,
      change: file.change!,
    })
  }
}

/** The file list for a session's changes (directory tree by default). */
export function ChangeTree(props: ChangeTreeProps): ReactElement {
  const [mode, setMode] = useState<TreeMode>('dir')
  // 4.x 过滤:搜索 / 操作 / 路径前缀。
  const [query, setQuery] = useState('')
  const [opFilter, setOpFilter] = useState<ReadonlySet<string>>(new Set())
  const [pathPrefix, setPathPrefix] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  // 4.x:窗口化渲染的滚动位置。
  const [scrollTop, setScrollTop] = useState(0)
  const treeRef = useRef<HTMLDivElement | null>(null)

  const filterActive = query !== '' || opFilter.size > 0 || pathPrefix !== ''
  const filtered = useMemo(() => {
    if (!filterActive) return props.changes
    const q = query.toLowerCase()
    return props.changes.filter(change => {
      const rel = relativePath(change)
      if (pathPrefix.length > 0 && !rel.startsWith(pathPrefix)) return false
      if (opFilter.size > 0 && !opFilter.has(change.operation)) return false
      if (q.length > 0) {
        const name = rel.split('/').pop() ?? rel
        if (!rel.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [props.changes, query, opFilter, pathPrefix, filterActive])

  const groups = useMemo(() => groupByExtension(filtered), [filtered])
  const root = useMemo(() => buildTree(filtered), [filtered])

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

  // 4.x:扁平化目录树 + 窗口切片。
  const flatRows = useMemo(() => {
    const out: FlatRow[] = []
    flattenTree(root, 0, collapsed, filterActive, out)
    return out
  }, [root, collapsed, filterActive])

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    setScrollTop((event.target as HTMLDivElement).scrollTop)
  }
  const viewHeight = 460
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(flatRows.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN)
  const windowed = flatRows.slice(start, end)

  const toggleOp = (op: string): void => {
    setOpFilter(prev => {
      const next = new Set(prev)
      if (next.has(op)) next.delete(op)
      else next.add(op)
      return next
    })
  }

  return createElement('div', { className: css.tree, ref: treeRef, onScroll },
    createElement('div', { className: css.title },
      createElement('span', null, '变更'),
      createElement('span', { className: css.titleCount }, filtered.length),
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
    // 4.x:过滤栏(搜索 / 操作 / 路径前缀)。
    createElement('div', { className: css.filters },
      createElement('input', {
        className: css.filterInput,
        placeholder: '搜索文件…',
        value: query,
        onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
      }),
      createElement('div', { className: css.opToggles },
        ['modify', 'create', 'delete'].map(op => createElement('button', {
          key: op,
          className: opFilter.has(op) ? css.opToggleOn : css.opToggle,
          onClick: () => toggleOp(op),
          title: op,
        }, op === 'modify' ? 'M' : op === 'create' ? 'A' : 'D')),
      ),
      createElement('input', {
        className: css.filterInput,
        placeholder: '路径: src/**',
        value: pathPrefix,
        onChange: (event: { target: { value: string } }) => setPathPrefix(event.target.value),
      }),
    ),
    filtered.length === 0
      ? props.loading === true
        ? createElement('div', { className: css.skeleton },
          createElement('div', { className: css.skeletonRow }),
          createElement('div', { className: css.skeletonRow, style: { width: '82%' } }),
          createElement('div', { className: css.skeletonRow, style: { width: '90%' } }),
          createElement('div', { className: css.skeletonRow, style: { width: '60%' } }),
        )
        : createElement('div', { className: css.empty },
          filterActive ? '没有匹配的变更' : '暂无文件变更')
      : mode === 'ext'
        ? groups.map(group => createElement('div', { key: group.label, className: css.extGroup },
          createElement('div', { className: css.groupHeader },
            createElement('span', { className: css.groupLabel }, group.label),
            createElement('span', { className: css.groupStats },
              `${group.changes.length} · +${group.additions} -${group.deletions}`),
          ),
          group.changes.map(change => renderFileRow(change, props, 0)),
        ))
        : createElement('div', { className: css.dirArea },
          createElement('div', { className: css.dirToolbar },
            createElement('button', { className: css.modeBtn, onClick: () => setAllCollapsed(true) }, '全部折叠'),
            createElement('button', { className: css.modeBtn, onClick: () => setAllCollapsed(false) }, '全部展开'),
          ),
          // 4.x:窗口化 —— 用 paddingTop/Bottom 占位,只渲染视口内行。
          createElement('div', {
            className: css.windowWrap,
            style: { paddingTop: start * ROW_HEIGHT, paddingBottom: (flatRows.length - end) * ROW_HEIGHT },
          },
          windowed.map(row => row.type === 'dir'
            ? createElement('button', {
              key: row.key,
              className: css.dirRow,
              style: { paddingLeft: 6 + row.depth * 14, height: ROW_HEIGHT },
              onClick: () => toggle(row.path),
              title: row.collapsed ? '展开目录' : '折叠目录',
            },
            createElement(Chevron, { collapsed: row.collapsed }),
            createElement('span', { className: css.dirName }, row.name),
            createElement('span', { className: css.dirStats },
              `${row.dir!.files} · +${row.dir!.additions} -${row.dir!.deletions}`),
            )
            : renderFileRow(row.change as WireChange, props, row.depth),
          ),
          ),
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

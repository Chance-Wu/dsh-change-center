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

import { createElement, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { WireChange, WireFinding, WireReview } from './index.ts'
import type { SideBySideRow, DiffHunk } from '../services/DiffService.ts'
import { countDiff, diffHunks, sideBySideRows } from '../services/DiffService.ts'
import { statusMeta } from './statusMeta.ts'
import { Segmented } from './Segmented.tsx'
import css from './DiffViewer.module.css'
import baseCss from './styles.module.css'

/** Props for the diff viewer. */
export type DiffMode = 'unified' | 'side-by-side' | 'editor'

export interface DiffViewerProps {
  change: WireChange
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  onSaved: (after: string) => void
  /** Qoder 风格块级操作:应用/撤销 diff 中单个 hunk。返回 true 表示成功。 */
  onHunk?: (index: number, revert: boolean) => Promise<boolean> | void
  /** Qoder 风格块内编辑:用 `lines` 替换某个 hunk 的写入内容。返回 true 表示成功。 */
  onEditHunk?: (index: number, lines: string[]) => Promise<boolean> | void
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
  /** 4.x AI 审查结果:存在时默认显示 AI 摘要,代码 diff 折叠展开。 */
  review?: WireReview | null
  /** 5.x 会话内全部变更(用于「相关文件」影响分析)。 */
  changes?: WireChange[]
  /** 5.x 点击相关文件时切换选中。 */
  onSelectChange?: (id: string) => void
  /** 5.x 无审查结果时,点击「运行 AI 审查」CTA。 */
  onRunReview?: () => void
  /** 只读:隐藏编辑模式与「运行 AI 审查」CTA —— 记录/展示面不设操作。 */
  readOnly?: boolean
}

/**
 * Diff renderer. The client bundle is a single file with no runtime module
 * table entries for the diff service, so the row alignment is re-implemented
 * here (same LCS semantics) rather than imported.
 */
export function DiffViewer(props: DiffViewerProps): ReactElement {
  const { change, mode, onModeChange, onSaved, disabled = false, readOnly = false } = props
  const rows: SideBySideRow[] = useMemo(() => sideBySideRows(change.before, change.after), [change.before, change.after])
  const counts = useMemo(() => countDiff(change.before, change.after), [change.before, change.after])
  const meta = statusMeta(change.status)
  // Qoder 风格 hunk 块:分割 + 应用状态(缺省=全部已应用,文件已是 after)。
  const hunks: DiffHunk[] = useMemo(() => diffHunks(change.before, change.after), [change.before, change.after])
  const applied = change.hunkApplied ?? hunks.map(() => true)
  const hunkEdits = change.hunkEdits ?? []

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
  // 编辑器行号:逻辑行 = 换行符分割(尾部空串表示结尾换行)。
  const draftLines = useMemo(() => {
    const lines = draft.split('\n')
    return lines.length > 0 ? lines : ['']
  }, [draft])
  const editorGutterRef = useRef<HTMLDivElement | null>(null)

  // diff 默认展开:完整代码始终可见,AI 摘要块在上方常显;可手动收起。
  const [diffOpen, setDiffOpen] = useState(true)
  // 5.x per-change 解释(从会话级 AI 审查按文件投影,零新增 LLM)。
  const explanation = useMemo(
    () => props.review !== undefined && props.review !== null ? buildExplanation(change, props.review, props.changes ?? []) : null,
    [change, props.review, props.changes],
  )
  // 默认展开:diff 不折叠(不再按行数阈值先收起)。

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
        // 语义配色按状态本身:applied=绿、failed=红,不再用 weight 二值映射
        // (weight 只表达强调度,无法区分「已应用」与「失败」)。
        createElement('span', {
          className: css.statusBadge,
          title: meta.label,
          'data-status': change.status,
        }, `${meta.icon} ${meta.label}`),
      ),
      createElement(Segmented, {
        segments: readOnly
          ? [
            { value: 'unified', label: '统一' },
            { value: 'side-by-side', label: '并排' },
          ]
          : [
            { value: 'unified', label: '统一' },
            { value: 'side-by-side', label: '并排' },
            { value: 'editor', label: '编辑' },
          ],
        value: mode,
        onChange: (next: string) => onModeChange(next as DiffMode),
      }),
    ),
    createElement('div', { className: css.content },
      // 5.x 解释卡:为什么改 / 影响 / 建议 + 相关文件。
      createElement(ExplanationCard, {
        change,
        explanation,
        review: props.review ?? null,
        // 只读面不提供「运行 AI 审查」操作。
        onRunReview: readOnly ? undefined : props.onRunReview,
        onSelectChange: props.onSelectChange,
      }),
      props.review !== undefined && props.review !== null
        ? createElement('button', {
          className: css.diffToggle,
          onClick: () => setDiffOpen(!diffOpen),
          'aria-expanded': diffOpen,
        }, `${diffOpen ? '▾' : '▸'} ${diffOpen ? '收起' : '展开'}代码 Diff`)
        : null,
      (diffOpen || props.review === undefined || props.review === null) && (
        mode === 'unified'
            ? (hunks.length > 0 && props.onHunk !== undefined && !readOnly
              ? createElement(HunkedView, { hunks, applied, edits: hunkEdits, onHunk: props.onHunk, onEditHunk: props.onEditHunk, layout: 'unified' })
              : createElement(UnifiedView, { change, findings: explanation?.findings ?? [] }))
            : mode === 'side-by-side'
              ? (hunks.length > 0 && props.onHunk !== undefined && !readOnly
                ? createElement(HunkedView, { hunks, applied, edits: hunkEdits, onHunk: props.onHunk, onEditHunk: props.onEditHunk, layout: 'side-by-side' })
                : createElement(SideBySideView, { rows }))
              : createElement('div', { className: css.editorArea },
        createElement('div', { className: css.editorWrap },
          // 行号 gutter:与文本框同步滚动(等宽字体 + 相同行高对齐)。
          createElement('div', { className: css.editorGutter, ref: editorGutterRef },
            draftLines.map((_, index) => createElement('div', { key: index, className: css.editorGutterLine }, String(index + 1)))),
          createElement('textarea', {
            value: draft,
            onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
            className: css.editorTextarea,
            spellCheck: false,
            onScroll: (event: { target: { scrollTop: number } }) => {
              if (editorGutterRef.current !== null) editorGutterRef.current.scrollTop = event.target.scrollTop
            },
          }),
        ),
        createElement('div', { className: css.editorActions },
          // 3.0.9:弱视觉 —— 脏状态由文件名旁的小圆点表达,这里只保留动作。
          justSaved
            ? createElement('span', { className: css.savedHint }, '✓ 已保存并应用')
            : null,
          dirty
            ? createElement('button', { onClick: discard, disabled, className: baseCss.buttonGhost }, '放弃')
            : null,
          createElement('button', { onClick: save, disabled: disabled || !dirty, className: baseCss.buttonPrimary }, '保存并应用'),
        ),
      )
      ),
    ),
  )
}

/** 4.x AI 变更摘要:先回答「AI 改了什么、是否安全」,再展开代码 Diff。 */
function AISummaryBlock(props: { review: WireReview; change: WireChange }): ReactElement {
  const { review, change } = props
  const findings = review.findings.filter(f => {
    if (f.filePath.length === 0) return false
    return change.path === f.filePath || change.path.endsWith(`/${f.filePath}`)
  })
  return createElement('div', { className: css.aiSummary },
    createElement('div', { className: css.aiSummaryHead },
      createElement('span', { className: css.aiSummaryTitle }, 'AI 变更摘要'),
      createElement('span', { className: css.aiSummaryRisk },
        `风险 ${RISK_ZH[review.risk] ?? review.risk} · 评分 ${review.score}`),
    ),
    review.summary.length > 0
      ? createElement('div', { className: css.aiSummaryText }, review.summary)
      : null,
    findings.length > 0
      ? createElement('ul', { className: css.aiFindings },
        findings.slice(0, 3).map(finding => createElement('li', { key: finding.id, className: css.aiFinding },
          createElement('span', { className: finding.severity === 'error' || finding.severity === 'critical' ? css.aiFindingError : css.aiFindingWarn },
            SEVERITY_ZH[finding.severity] ?? finding.severity),
          createElement('span', null, finding.title),
        )),
      )
      : createElement('div', { className: css.aiSummaryOk }, '✓ 本文件未发现审查问题'),
  )
}

const RISK_ZH: Record<string, string> = { low: '低', medium: '中', high: '高', critical: '严重' }
const SEVERITY_ZH: Record<string, string> = {
  critical: '严重', error: '错误', warning: '警告', info: '提示',
}

/** 5.x per-change 解释:从会话级 AI 审查按文件投影(零新增 LLM)。 */
interface ChangeExplanation {
  findings: WireFinding[]
  reason: string
  risks: string[]
  suggestion: string
  relatedFiles: { id: string; path: string; operation: string; status: string }[]
}

/** 该文件的 findings(路径精确/后缀匹配)。 */
function findingsFor(change: WireChange, review: WireReview): WireFinding[] {
  return review.findings.filter(f => {
    if (f.filePath.length === 0) return false
    return change.path === f.filePath || change.path.endsWith(`/${f.filePath}`)
  })
}

/** 同目录判定(父目录相同)。 */
function sameDir(a: string, b: string): boolean {
  const ia = a.lastIndexOf('/')
  const ib = b.lastIndexOf('/')
  if (ia < 0 || ib < 0) return a === b
  return a.slice(0, ia) === b.slice(0, ib)
}

function buildExplanation(change: WireChange, review: WireReview, changes: WireChange[]): ChangeExplanation {
  const findings = findingsFor(change, review)
  const reason = findings.map(f => f.title).filter(Boolean).join('；')
  const risks = [...new Set(findings.map(f => f.severity))]
  const suggestion = findings.find(f => f.suggestion !== undefined && f.suggestion.length > 0)?.suggestion ?? ''
  // 相关文件:同目录的其他变更 + 被 review 提及的其他文件。
  const related = changes
    .filter(c => c.id !== change.id && c.kind !== 'command')
    .filter(c => sameDir(relativeName(change), relativeName(c)) || review.findings.some(f => matchesAny(c, f.filePath)))
    .slice(0, 6)
    .map(c => ({ id: c.id, path: c.path.split('/').pop() ?? c.path, operation: c.operation, status: c.status }))
  return { findings, reason, risks, suggestion, relatedFiles: related }
}

function relativeName(change: WireChange): string {
  const base = (change.cwd ?? '').replace(/\/+$/, '')
  if (base.length > 0 && change.path.startsWith(`${base}/`)) return change.path.slice(base.length + 1)
  return change.path
}

function matchesAny(change: WireChange, filePath: string): boolean {
  if (filePath.length === 0) return false
  return change.path === filePath || change.path.endsWith(`/${filePath}`)
}

/** 5.x 解释卡:为什么改 / 影响 / 建议 + 相关文件(影响分析)。 */
function ExplanationCard(props: {
  change: WireChange
  explanation: ChangeExplanation | null
  review: WireReview | null
  onRunReview?: () => void
  onSelectChange?: (id: string) => void
}): ReactElement {
  const { change, explanation, review, onRunReview, onSelectChange } = props
  const showCta = review === null && onRunReview !== undefined
  const hasContent = explanation !== null && (explanation.reason.length > 0 || explanation.suggestion.length > 0 || explanation.relatedFiles.length > 0)
  if (showCta) {
    return createElement('div', { className: css.explanation },
      createElement('div', { className: css.explanationHead },
        createElement('span', { className: css.explanationTitle }, 'AI 变更解释'),
        createElement('button', { onClick: onRunReview, className: baseCss.buttonMini }, '运行 AI 审查'),
      ),
      createElement('div', { className: css.explanationMuted }, '运行审查后,这里会解释该文件「为什么改 / 影响 / 建议」。'),
    )
  }
  if (explanation === null || !hasContent) return createElement(ReactNull, null)
  return createElement('div', { className: css.explanation },
    createElement('div', { className: css.explanationHead },
      createElement('span', { className: css.explanationTitle }, 'AI 变更解释'),
      explanation.risks.length > 0
        ? createElement('span', { className: css.explanationRisks },
          explanation.risks.map(risk => createElement('span', { key: risk, className: riskSeverityClass(risk) }, SEVERITY_ZH[risk] ?? risk)))
        : null,
    ),
    explanation.reason.length > 0
      ? createElement('div', { className: css.explanationRow },
        createElement('span', { className: css.explanationLabel }, '为什么改'),
        createElement('span', { className: css.explanationText }, explanation.reason))
      : null,
    explanation.suggestion.length > 0
      ? createElement('div', { className: css.explanationRow },
        createElement('span', { className: css.explanationLabel }, '建议'),
        createElement('span', { className: css.explanationText }, explanation.suggestion))
      : null,
    explanation.relatedFiles.length > 0
      ? createElement('div', { className: css.explanationRow },
        createElement('span', { className: css.explanationLabel }, '影响'),
        createElement('div', { className: css.relatedFiles },
          explanation.relatedFiles.map(file => createElement('button', {
            key: file.id,
            className: css.relatedFile,
            onClick: () => onSelectChange?.(file.id),
            title: '点击查看该文件',
          },
          createElement('span', { className: file.operation === 'delete' ? css.relatedDel : file.operation === 'create' ? css.relatedAdd : css.relatedMod }, OPERATION_MARK[file.operation] ?? '?'),
          createElement('span', { className: css.relatedPath }, file.path),
          )),
        ))
      : null,
  )
}

/** 无内容占位(解释卡空态)。 */
function ReactNull(): ReactElement { return null as unknown as ReactElement }

/** severity → 风险 chip 类。 */
function riskSeverityClass(severity: string): string {
  if (severity === 'error' || severity === 'critical') return css.riskChipError
  if (severity === 'warning') return css.riskChipWarn
  return css.riskChipInfo
}

const OPERATION_MARK: Record<string, string> = { create: 'A', modify: 'M', delete: 'D', rename: 'R' }

/** 行内标注:unified diff 行号映射(finding.line 命中)。 */
function unifiedLineNumbers(lines: string[]): { before: (number | null)[]; after: (number | null)[] } {
  const before: (number | null)[] = []
  const after: (number | null)[] = []
  let b = 0
  let a = 0
  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) { before.push(null); after.push(null); continue }
    if (line.startsWith('-') && !line.startsWith('--')) { before.push(b + 1); after.push(null); b++ }
    else if (line.startsWith('+') && !line.startsWith('++')) { before.push(null); after.push(a + 1); a++ }
    else { before.push(b + 1); after.push(a + 1); b++; a++ }
  }
  return { before, after }
}


/** Qoder 风格:hunk 分组的 diff 视图 —— 操作按钮直接融入每块头部的操作栏
 *  (行号区间 + 已应用/已撤销 + 编辑/撤销该块/应用该块),不再使用浮动面板;
 *  点击任意块定位、↑/↓ 自由跳转、操作成功自动跳下一块。
 *  `layout='unified'` 单栏 -/+ 行;`layout='side-by-side'` 双栏 before|after。 */
function HunkedView(props: {
  hunks: DiffHunk[]
  applied: boolean[]
  edits: (string[] | null)[]
  onHunk: (index: number, revert: boolean) => Promise<boolean> | void
  onEditHunk?: (index: number, lines: string[]) => Promise<boolean> | void
  layout: 'unified' | 'side-by-side'
}): ReactElement {
  const { hunks, applied, edits, onHunk, onEditHunk, layout } = props
  const [active, setActive] = useState(0)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const refs = useRef<(HTMLDivElement | null)[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 每个块在 after 文件中的起始行号:beforeStart + 前面所有块的净增量
  // (afterLines − beforeLines)。插入行号 = afterStart + i,与并排/统一一致。
  const afterStarts = useMemo(() => {
    const starts: number[] = []
    let delta = 0
    for (const hunk of hunks) {
      starts.push(hunk.beforeStart + delta)
      delta += hunk.afterLines.length - hunk.beforeLines.length
    }
    return starts
  }, [hunks])

  // hunk 数变化(全文编辑后)时收敛激活块。
  useEffect(() => {
    if (active >= hunks.length) setActive(Math.max(0, hunks.length - 1))
  }, [hunks.length, active])

  /** 程序化跳转时间戳:跳转后的短窗口内,onScroll 自动跟踪不覆盖跳转目标。 */
  const jumpLockRef = useRef(0)

  /** 滚动容器内把某块定位到容器顶部,并设为当前块(操作栏高亮)。 */
  const scrollTo = (index: number): void => {
    if (index < 0 || index >= hunks.length) return
    jumpLockRef.current = Date.now()
    setActive(index)
    const container = scrollRef.current
    const el = refs.current[index]
    // 防御:元素必须仍挂在容器内(合并/刷新时 ref 可能短暂指向旧元素,
    // 其 offsetTop 失真会把容器滚到底、atBottom 误选最后一块)。
    if (container === null || el === null || el === undefined || !container.contains(el)) return
    // 1) 容器内部滚动到块顶。
    container.scrollTop = Math.max(0, el.offsetTop - 8)
    // 2) 把容器带进页面视野。
    container.scrollIntoView({ block: 'nearest' })
    // 3) 下一帧解锁,允许自动跟踪恢复(scrollIntoView 可能刚改变了滚动位置)。
    requestAnimationFrame(() => {
      if (Date.now() - jumpLockRef.current >= 180) jumpLockRef.current = 0
    })
  }
  const next = (): void => scrollTo(active + 1)
  const prev = (): void => scrollTo(active - 1)

  /** 跟随滑动:自动激活容器顶部处的块;滚动到底部时选中最后一块。 */
  const onScroll = (): void => {
    const container = scrollRef.current
    if (container === null) return
    // 程序化跳转后的短窗口内,不覆盖跳转目标(避免 1→2 被旧几何改写成 4)。
    if (Date.now() - jumpLockRef.current < 180) return
    const scrollable = container.scrollHeight > container.clientHeight + 2
    const atBottom = scrollable && container.scrollTop + container.clientHeight >= container.scrollHeight - 2
    let best = 0
    for (let i = 0; i < hunks.length; i++) {
      const el = refs.current[i]
      if (el === null) continue
      if (el.offsetTop - container.scrollTop <= 8) best = i
      else break
    }
    // 底部特例:最后一小块可能顶边在参考线下方,永远轮不到它被选中。
    if (atBottom) best = hunks.length - 1
    if (best !== active) setActive(best)
  }

  // 操作成功后自动跳到下一个块;失败停留在当前块。
  const finish = (ok: boolean, index: number): void => {
    setEditing(null)
    if (ok && index + 1 < hunks.length) scrollTo(index + 1)
  }
  const runOp = (index: number, op: () => Promise<boolean> | void): void => {
    const result = op()
    if (result !== undefined && typeof (result as Promise<boolean>).then === 'function') {
      ;(result as Promise<boolean>).then(ok => finish(ok !== false, index))
    } else {
      finish(true, index)
    }
  }

  const startEdit = (index: number): void => {
    const current = edits[index] ?? hunks[index]?.afterLines ?? []
    setEditing(index)
    setDraft(current.join('\n'))
  }
  const saveEdit = (index: number): void => {
    if (onEditHunk === undefined) return
    const lines = draft.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    runOp(index, () => onEditHunk(index, lines))
  }

  // 全页监听 ↑/↓:不在输入框内时自由跳转(操作完自动跳块之外的可选导航)。
  // capture + stopImmediatePropagation:块导航优先于面板级 J/K/↑↓ 文件导航 ——
  // 否则按 ↓ 会同时「跳下一块」与「切到下一个文件」(ChangeReviewPanel 也监听箭头键)。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key === 'ArrowDown') { event.preventDefault(); event.stopImmediatePropagation(); next() }
      else if (event.key === 'ArrowUp') { event.preventDefault(); event.stopImmediatePropagation(); prev() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const stop = (handler: () => void) => (event: { stopPropagation: () => void }) => { event.stopPropagation(); handler() }

  return createElement('div', { className: css.hunkScroll, ref: scrollRef, onScroll },
    layout === 'side-by-side'
      ? createElement('div', { className: css.hunkSideHeader },
        createElement('div', { className: css.sideColHeader }, '修改前'),
        createElement('div', { className: `${css.sideColHeader} ${css.sideColAfter}` }, '修改后'))
      : null,
    hunks.map(hunk => {
      const isApplied = applied[hunk.index] ?? true
      const isActive = active === hunk.index
      const isEditing = editing === hunk.index
      // 显示行:块内编辑后取编辑内容,否则取原始 after。
      const displayLines = edits[hunk.index] ?? hunk.afterLines
      return createElement('div', {
        key: hunk.index,
        ref: (el: HTMLDivElement | null): void => { refs.current[hunk.index] = el },
        className: isActive ? `${css.hunkFlow} ${css.hunkFlowActive}` : css.hunkFlow,
        // 点击任意块 = 设为当前块(滚动定位到容器顶部)。
        onClick: () => scrollTo(hunk.index),
      },
      // 块操作栏融入 diff:行号区间 + 已应用/已撤销 + 图标操作(取代浮动面板)。
      createElement('div', {
        className: isActive ? `${css.hunkBar} ${css.hunkBarActive}` : css.hunkBar,
      },
      createElement('span', { className: css.hunkRange },
        `-${hunk.beforeStart}${hunk.beforeLines.length > 1 ? `,${hunk.beforeLines.length}` : ''} ` +
        `+${afterStarts[hunk.index]}${displayLines.length > 1 ? `,${displayLines.length}` : ''}`),
      createElement('span', { className: isApplied ? css.hunkAppliedTag : css.hunkRevertedTag },
        isApplied ? '已应用' : '已撤销'),
      createElement('div', { className: css.hunkBarActions },
        isApplied && !isEditing && onEditHunk !== undefined
          ? createElement(TipButton, { tip: '编辑该块', onClick: stop(() => startEdit(hunk.index)) }, ICON_EDIT)
          : null,
        !isEditing
          ? (isApplied
            ? createElement(TipButton, { tip: '撤销该块', className: css.hunkIconRevert, onClick: stop(() => runOp(hunk.index, () => onHunk(hunk.index, true))) }, ICON_UNDO)
            : createElement(TipButton, { tip: '应用该块', className: css.hunkIconApply, onClick: stop(() => runOp(hunk.index, () => onHunk(hunk.index, false))) }, ICON_CHECK))
          : null,
      ),
      ),
      isEditing
        ? createElement('div', { className: css.hunkEditArea },
          createElement('textarea', {
            className: css.hunkTextarea,
            value: draft,
            autoFocus: true,
            spellCheck: false,
            onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
            onKeyDown: (event: { key: string; stopPropagation: () => void }) => {
              if (event.key === 'Escape') { setEditing(null); event.stopPropagation() }
            },
          }),
          createElement('div', { className: css.hunkEditActions },
            createElement('button', { className: baseCss.buttonPrimary, onClick: () => saveEdit(hunk.index) }, '保存该块'),
            createElement('button', { className: baseCss.buttonGhost, onClick: () => setEditing(null) }, '放弃'),
          ),
        )
        : layout === 'side-by-side'
          ? sideHunkBody(hunk, isApplied, displayLines, afterStarts[hunk.index])
          : unifiedHunkBody(hunk, isApplied, displayLines, afterStarts[hunk.index]),
      )
    }),
  )
}

/** 16 viewBox stroke 图标(lucide 风格路径;与项目 chevron 同风格)。 */
function Icon(props: { d: string[]; size?: number }): ReactElement {
  return createElement('svg', {
    viewBox: '0 0 24 24',
    width: props.size ?? 14,
    height: props.size ?? 14,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }, props.d.map(d => createElement('path', { key: d, d })))
}

/** 编辑(铅笔)。 */
const ICON_EDIT: ReactElement = createElement(Icon, { d: ['M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z', 'm15 5 4 4'] })
/** 撤销该块(回退箭头)。 */
const ICON_UNDO: ReactElement = createElement(Icon, { d: ['M3 7v6h6', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'] })
/** 应用该块(对勾)。 */
const ICON_CHECK: ReactElement = createElement(Icon, { d: ['M20 6 9 17l-5-5'] })

/**
 * 图标操作按钮 + hover 说明浮层。不用 `title`(延迟且不可控);说明用 fixed
 * 定位气泡(脱离 hunkScroll 滚动容器的裁剪),hover/聚焦时跟随按钮位置显示。
 */
function TipButton(props: {
  tip: string
  onClick: (event: { stopPropagation: () => void }) => void
  className?: string
  children?: ReactElement
}): ReactElement {
  const { tip, onClick, className, children } = props
  const [tipPos, setTipPos] = useState<{ x: number; y: number; below: boolean } | null>(null)
  const ref = useRef<HTMLButtonElement | null>(null)
  const show = (): void => {
    const el = ref.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    // 视口顶部空间不足(首块)时改在按钮下方显示,避免浮层被视口裁掉。
    const below = rect.top < 44
    setTipPos({ x: rect.left + rect.width / 2, y: below ? rect.bottom + 6 : rect.top - 6, below })
  }
  const hide = (): void => setTipPos(null)
  return createElement('div', { className: css.iconTipHost },
    createElement('button', {
      ref,
      type: 'button',
      className: className ?? css.hunkIconBtn,
      onClick,
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: show,
      onBlur: hide,
      'aria-label': tip,
    }, children),
    tipPos !== null
      ? createElement('div', {
        className: css.hunkTip,
        style: { left: tipPos.x, top: tipPos.y, transform: `translate(-50%, ${tipPos.below ? '0' : '-100%'})` },
      }, tip)
      : null,
  )
}

/** 单栏块体(统一模式):- 删除行(before 行号)+ 插入行(after 行号);已撤销 = before 灰行。 */
function unifiedHunkBody(hunk: DiffHunk, isApplied: boolean, displayLines: string[], afterStart: number): ReactElement {
  return createElement('div', null,
    hunk.beforeLines.map((line, i) => createElement('div', {
      key: `b-${i}`,
      className: isApplied ? `${css.hunkLine} ${css.diffLineRemoved}` : `${css.hunkLine} ${css.diffLineContext}`,
    },
    createElement('span', { className: css.lineNo }, String(hunk.beforeStart + i)),
    createElement('span', null, `${isApplied ? '-' : ' '}${line}`))),
    isApplied
      ? displayLines.map((line, i) => createElement('div', {
        key: `a-${i}`,
        className: `${css.hunkLine} ${css.diffLineAdded}`,
      },
      createElement('span', { className: css.lineNo }, String(afterStart + i)),
      createElement('span', null, `+${line}`)))
      : null,
  )
}

/** 双栏块体(并排模式):左 = before(删除红 / 已撤销灰),右 = after(插入绿),行号齐全。 */
function sideHunkBody(hunk: DiffHunk, isApplied: boolean, displayLines: string[], afterStart: number): ReactElement {
  const rows = isApplied ? Math.max(hunk.beforeLines.length, displayLines.length) : hunk.beforeLines.length
  const out: ReactElement[] = []
  for (let i = 0; i < rows; i++) {
    const beforeLine = i < hunk.beforeLines.length ? hunk.beforeLines[i] : null
    const afterLine = isApplied && i < displayLines.length ? displayLines[i] : null
    out.push(createElement('div', {
      key: i,
      className: [
        css.sideRow,
        beforeLine !== null ? (isApplied ? css.sideRowDeletion : css.sideRowContext) : null,
        afterLine !== null ? css.sideRowInsertion : null,
      ].filter(Boolean).join(' '),
    },
    createElement('div', { className: css.sideCol },
      createElement('span', { className: css.lineNo }, beforeLine !== null ? String(hunk.beforeStart + i) : ''),
      beforeLine !== null ? createElement('span', { className: `${css.sideText} ${isApplied ? css.sideColDelText : css.sideColContextText}` }, beforeLine) : null,
    ),
    createElement('div', { className: `${css.sideCol} ${css.sideColAfter}` },
      createElement('span', { className: css.lineNo }, afterLine !== null ? String(afterStart + i) : ''),
      afterLine !== null ? createElement('span', { className: `${css.sideText} ${css.sideColInsText}` }, afterLine) : null,
    ),
    ))
  }
  return createElement('div', { className: css.hunkSide }, ...out)
}

/** Unified diff: one line per annotated diff row, with inline finding annotations. */
function UnifiedView(props: { change: WireChange; findings: WireFinding[] }): ReactElement {
  const { change, findings } = props
  const lines = diffTextLines(change.diff)
  const nums = unifiedLineNumbers(lines)
  // diff 行下标 → 命中的 findings(按 before/after 行号)。
  const hits = new Map<number, WireFinding[]>()
  for (const f of findings) {
    if (f.line === undefined) continue
    lines.forEach((_, i) => {
      if (nums.before[i] === f.line || nums.after[i] === f.line) {
        const arr = hits.get(i) ?? []
        arr.push(f)
        hits.set(i, arr)
      }
    })
  }
  return createElement('div', { className: css.diffBody },
    lines.map((line, index) => {
      const kind = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context'
      const hit = hits.get(index)
      return createElement('div', {
        key: index,
        className: kind === 'added' ? css.diffRowAdded
          : kind === 'removed' ? css.diffRowRemoved
            : css.diffRow,
      },
      // 行号 gutter:context 显示「before:after」,单侧变更显示对应侧号。
      createElement('span', { className: css.lineNo },
        `${nums.before[index] !== null ? nums.before[index] : ''}${nums.before[index] !== null && nums.after[index] !== null ? ':' : ''}${nums.after[index] !== null ? nums.after[index] : ''}`),
      createElement('span', { className: css.lineText }, line),
      hit !== undefined
        ? createElement('span', { className: css.inlineNote, title: hit.map(h => h.title).join('；') },
          hit.map(h => createElement('span', { key: h.id, className: severityNoteClass(h.severity) }, '●')),
        )
        : null,
      )
    }),
    lines.length === 0 ? createElement('div', { className: css.diffNoChange }, '(无变更)') : null,
  )
}

function severityNoteClass(severity: string): string {
  if (severity === 'error' || severity === 'critical') return css.noteError
  if (severity === 'warning') return css.noteWarn
  return css.noteInfo
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
      createElement('div', { className: `${css.sideColHeader} ${css.sideColAfter}` }, '修改后'),
    ),
    rows.map((row, index) => createElement('div', {
      key: index,
      className: [
        css.sideRow,
        row.deletion ? css.sideRowDeletion : row.insertion ? css.sideRowInsertion : undefined,
      ].filter(Boolean).join(' '),
    },
    createElement('div', { className: css.sideCol },
      createElement('span', { className: css.lineNo }, row.beforeNo ?? ''),
      row.deletion || !row.insertion ? createElement('span', { className: `${css.sideText} ${css.sideColDelText}` }, row.before ?? '') : null,
    ),
    createElement('div', { className: `${css.sideCol} ${css.sideColAfter}` },
      createElement('span', { className: css.lineNo }, row.afterNo ?? ''),
      row.insertion || !row.deletion ? createElement('span', { className: `${css.sideText} ${css.sideColInsText}` }, row.after ?? '') : null,
    ),
    )),
  )
}

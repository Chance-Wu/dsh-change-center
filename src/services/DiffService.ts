/**
 * Unified-diff generation for captured before/after text.
 *
 * Deliberately dependency-free: a classic LCS over lines yields a minimal
 * insertion/deletion pair, rendered as a `- old / + new` unified-style diff
 * suitable for the MVP review surface (Monaco lands in a later phase).
 * @module dsh-change-center/services
 */

/** One diff edit: either a deletion, an insertion, or a shared context line. */
export interface DiffLine {
  kind: 'context' | 'del' | 'ins'
  text: string
}

/**
 * LCS runs in O(n·m) time and space; beyond this many table cells the diff
 * falls back to a full-replacement edit script (O(n+m)) so huge files
 * (lockfiles, generated code) cannot OOM the host or freeze the UI.
 */
const MAX_LCS_CELLS = 4_000_000

/**
 * Compute the line-level LCS edit script between `before` and `after`.
 * Returns lines annotated with their diff kind, preserving order. Files whose
 * size would overflow the LCS table use a degenerate replace-all script.
 * @param before - the pre-mutation text (null treated as empty).
 * @param after - the post-mutation text (null treated as empty).
 */
export function diffLines(before: string | null, after: string | null): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length * b.length > MAX_LCS_CELLS) return replaceAll(a, b)
  const lcs = computeLcs(a, b)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  for (const item of lcs) {
    while (i < item.a) {
      out.push({ kind: 'del', text: a[i] })
      i++
    }
    while (j < item.b) {
      out.push({ kind: 'ins', text: b[j] })
      j++
    }
    out.push({ kind: 'context', text: a[i] })
    i++
    j++
  }
  while (i < a.length) {
    out.push({ kind: 'del', text: a[i] })
    i++
  }
  while (j < b.length) {
    out.push({ kind: 'ins', text: b[j] })
    j++
  }
  return out
}

/** Degenerate edit script for oversized files: delete all, insert all. */
function replaceAll(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = []
  for (const text of a) out.push({ kind: 'del', text })
  for (const text of b) out.push({ kind: 'ins', text })
  return out
}

/** Render the annotated diff as unified-style text (`-`/`+`/` ` prefixed). */
export function renderUnified(before: string | null, after: string | null): string {
  const lines = diffLines(before, after)
  if (lines.every(line => line.kind === 'context')) {
    return '(no changes)'
  }
  return lines
    .map(line => `${prefix(line.kind)}${line.text}`)
    .join('\n')
}

/** Line-count summary of a diff: inserted and deleted lines. */
export interface DiffCounts {
  additions: number
  deletions: number
}

/** Count inserted/deleted lines between `before` and `after`. */
export function countDiff(before: string | null, after: string | null): DiffCounts {
  const lines = diffLines(before, after)
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.kind === 'ins') additions++
    else if (line.kind === 'del') deletions++
  }
  return { additions, deletions }
}

/** One line of a side-by-side diff: paired old/new texts, or a single-side edit. */
export interface SideBySideRow {
  /** True when only the after side changed (insertion). */
  insertion: boolean
  /** True when only the before side changed (deletion). */
  deletion: boolean
  before?: string
  after?: string
  /** 1-based line number in the before text (context/del rows). */
  beforeNo?: number
  /** 1-based line number in the after text (context/ins rows). */
  afterNo?: number
}

/**
 * Align `before`/`after` lines for a two-column view. Context rows carry
 * both texts; a deletion carries only `before`; an insertion only `after`.
 */
export function sideBySideRows(before: string | null, after: string | null): SideBySideRow[] {
  const lines = diffLines(before, after)
  const rows: SideBySideRow[] = []
  let beforeNo = 0
  let afterNo = 0
  for (const line of lines) {
    if (line.kind === 'context') {
      beforeNo++
      afterNo++
      rows.push({ insertion: false, deletion: false, before: line.text, after: line.text, beforeNo, afterNo })
    } else if (line.kind === 'del') {
      beforeNo++
      rows.push({ insertion: false, deletion: true, before: line.text, beforeNo })
    } else {
      afterNo++
      rows.push({ insertion: true, deletion: false, after: line.text, afterNo })
    }
  }
  return rows
}

function prefix(kind: DiffLine['kind']): string {
  switch (kind) {
    case 'context': return ' '
    case 'del': return '-'
    case 'ins': return '+'
  }
}

/** Split text into lines, stripping a single trailing newline like `diff`. */
function splitLines(text: string | null): string[] {
  if (text === null) return []
  const normalized = text.replace(/\r\n/g, '\n')
  return normalized.split('\n').slice(0, -1)
}

interface LcsItem {
  a: number
  b: number
}

/** Longest-common-subsequence over lines via the classic DP table. */
function computeLcs(a: string[], b: string[]): LcsItem[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: LcsItem[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ a: i, b: j })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return out
}

/** One change block (hunk) of a diff: the before region + its replacement. */
export interface DiffHunk {
  index: number
  /** 1-based line in the BEFORE text where this hunk's region starts. */
  beforeStart: number
  /** Lines this hunk removes from before (empty for pure insertions). */
  beforeLines: string[]
  /** Lines this hunk inserts (empty for pure deletions). */
  afterLines: string[]
  additions: number
  deletions: number
}

/**
 * Split an annotated diff into hunks: contiguous del/ins runs form one hunk,
 * context lines between runs separate hunks. Each hunk records its position in
 * the BEFORE text and the replacement lines, so a caller can apply or revert a
 * single hunk by reconstructing the before text.
 */
export function diffHunks(before: string | null, after: string | null): DiffHunk[] {
  const lines = diffLines(before, after)
  const hunks: DiffHunk[] = []
  let beforeNo = 0
  let current: DiffHunk | null = null
  for (const line of lines) {
    if (line.kind === 'context') {
      beforeNo++
      current = null
      continue
    }
    if (line.kind === 'del') {
      beforeNo++
      if (current === null) {
        current = { index: hunks.length, beforeStart: beforeNo, beforeLines: [], afterLines: [], additions: 0, deletions: 0 }
        hunks.push(current)
      }
      current.beforeLines.push(line.text)
      current.deletions++
    } else {
      if (current === null) {
        current = { index: hunks.length, beforeStart: beforeNo + 1, beforeLines: [], afterLines: [], additions: 0, deletions: 0 }
        hunks.push(current)
      }
      current.afterLines.push(line.text)
      current.additions++
    }
  }
  return hunks
}

/**
 * Reconstruct the file text from `before` with the given hunks applied
 * (hunk k applied ⇒ its beforeLines are replaced by afterLines; unapplied
 * hunks keep the before content). `edits` optionally overrides a hunk's
 * afterLines (Qoder 风格块内编辑:该块写入用户修改后的行,`null` = 原 after)。
 * Preserves `before`'s trailing newline.
 */
export function applyHunks(before: string | null, hunks: DiffHunk[], applied: boolean[], edits?: (string[] | null)[]): string {
  const a = splitLines(before)
  let out = a
  let delta = 0
  const ordered = [...hunks].sort((x, y) => x.beforeStart - y.beforeStart)
  for (const hunk of ordered) {
    if (!(applied[hunk.index] ?? false)) continue
    const start = hunk.beforeStart - 1 + delta
    const beforeLen = hunk.beforeLines.length
    const replacement = edits?.[hunk.index] ?? hunk.afterLines
    out = [...out.slice(0, start), ...replacement, ...out.slice(start + beforeLen)]
    delta += replacement.length - beforeLen
  }
  const body = out.join('\n')
  return before !== null && before.endsWith('\n') && body.length > 0 ? `${body}\n` : body
}

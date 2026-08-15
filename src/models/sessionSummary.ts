/**
 * Session natural-language summary (3.x 摘要质量提升) — ONE deterministic
 * implementation shared by the host (persisted `ChangeSession.summary`) and
 * the client (fallback for old sessions). No LLM involved.
 *
 * Priority: 单文件 → 单目录 → 双目录 → 混合。
 * - 「修改 LoginService.java」
 * - 「修改 src/auth 下 3 个文件」
 * - 「修改 src/auth 和 src/user 下 5 个文件」
 * - 「修改 4 个文件，包括 src/auth/LoginService.java」
 * @module dsh-change-center/models
 */

/** Minimal shape a summary can be derived from (host FileChange or wire change). */
export interface SummarizableChange {
  path: string
  cwd: string
  kind?: string
  operation: string
}

/** Path relative to the change's workspace; absolute/outside paths verbatim. */
function relPathOf(change: SummarizableChange): string {
  const base = (change.cwd ?? '').replace(/\/+$/, '')
  if (base.length > 0 && change.path.startsWith(`${base}/`)) {
    return change.path.slice(base.length + 1)
  }
  return change.path
}

/** Dirname of a relative path ('src/auth/token.ts' → 'src/auth'; '' for a bare file). */
function dirOf(rel: string): string {
  const idx = rel.lastIndexOf('/')
  return idx > 0 ? rel.slice(0, idx) : ''
}

/**
 * One-line summary of a session's file changes (deterministic; shared by
 * host persistence and client fallback).
 */
export function summarizeChanges(changes: SummarizableChange[]): string {
  const files = changes.filter(c => c.kind === undefined || c.kind === 'file')
  if (files.length === 0) return '无文件变更'
  const ops = { create: 0, modify: 0, delete: 0, rename: 0 }
  const relPaths: string[] = []
  for (const change of files) {
    if (change.operation === 'create' || change.operation === 'modify' || change.operation === 'delete' || change.operation === 'rename') {
      ops[change.operation] += 1
    }
    relPaths.push(relPathOf(change))
  }
  const verb = ops.create === files.length ? '新增' : ops.delete === files.length ? '删除' : '修改'
  const dirs = [...new Set(relPaths.map(dirOf).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const hasRoot = relPaths.some(rel => dirOf(rel) === '')

  // 单文件:「修改 LoginService.java」
  if (files.length === 1) return `${verb} ${relPaths[0]}`
  // 单目录:「修改 src/auth 下 3 个文件」
  if (dirs.length === 1 && !hasRoot) return `${verb} ${dirs[0]} 下 ${files.length} 个文件`
  // 双目录:「修改 src/auth 和 src/user 下 5 个文件」
  if (dirs.length === 2 && !hasRoot) return `${verb} ${dirs[0]} 和 ${dirs[1]} 下 ${files.length} 个文件`
  // 混合:「修改 4 个文件，包括 src/auth/LoginService.java」
  return `${verb} ${files.length} 个文件，包括 ${relPaths[0]}`
}

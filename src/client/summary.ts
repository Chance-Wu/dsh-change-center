/**
 * Natural-language session summaries (Vibe UI, V-3).
 *
 * Client-side heuristic: derives a one-line "what did AI change" from the
 * reviewable file changes' relative paths and operations — no host data
 * beyond the changes themselves. In 2.3 this is upgraded to a host-side
 * `ChangeSession.summary` extracted from agent turn text; this function
 * remains the fallback for sessions without one.
 * @module dsh-change-center/client
 */

import { relativePath } from './ChangeTree.tsx'
import type { WireChange } from './index.ts'

/** Dirname of a relative path ('src/auth/token.ts' → 'src/auth'; '' for a bare file). */
function dirOf(rel: string): string {
  const idx = rel.lastIndexOf('/')
  return idx > 0 ? rel.slice(0, idx) : ''
}

/**
 * Longest directory prefix shared by every path ('' when there is none).
 * `src/auth/token.ts` + `src/auth/service.ts` → `src/auth`.
 */
function commonDir(dirs: string[]): string {
  if (dirs.length === 0) return ''
  const parts = dirs[0]!.split('/')
  let depth = 0
  outer: for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(0, i + 1).join('/')
    for (const dir of dirs) {
      if (!(dir === prefix || dir.startsWith(`${prefix}/`))) break outer
    }
    depth = i + 1
  }
  return parts.slice(0, depth).join('/')
}

/**
 * One-line summary of a session's file changes, e.g.
 * 「修改 src/auth 下 3 个文件」/「新增 src/lib 下 2 个文件」/「删除 1 个文件」.
 * Deterministic and pure so it can be unit-tested and reused across surfaces.
 */
export function summarizeChanges(changes: WireChange[]): string {
  const files = changes.filter(c => c.kind === 'file')
  if (files.length === 0) return '无文件变更'
  const ops = { create: 0, modify: 0, delete: 0, rename: 0 }
  const dirs: string[] = []
  for (const change of files) {
    const operation = change.operation
    if (operation === 'create' || operation === 'modify' || operation === 'delete' || operation === 'rename') {
      ops[operation] += 1
    }
    const dir = dirOf(relativePath(change))
    if (dir.length > 0) dirs.push(dir)
  }
  const onlyCreates = ops.create === files.length
  const onlyDeletes = ops.delete === files.length
  const verb = onlyCreates ? '新增' : onlyDeletes ? '删除' : '修改'
  const dir = commonDir(dirs)
  const where = dir.length > 0 ? ` ${dir} 下` : ''
  return `${verb}${where} ${files.length} 个文件`
}

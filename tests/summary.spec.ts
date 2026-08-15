/**
 * summarizeChanges tests (Vibe UI V-3): the client-side session summary
 * heuristic derives "what did AI change" from paths and operations.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { summarizeChanges } from '../src/client/summary.ts'
import type { WireChange } from '../src/client/index.ts'

/** Build a minimal file change for pure-function tests. */
function change(over: Partial<WireChange> = {}): WireChange {
  return {
    id: 'c1', sessionId: 's1', cwd: '/ws', kind: 'file', path: '/ws/a.ts',
    operation: 'modify', before: 'x\n', after: 'y\n', diff: '-x\n+y\n',
    status: 'pending', source: 'agent', toolName: 'edit', createdAt: 0, updatedAt: 0,
    ...over,
  }
}

describe('summarizeChanges', () => {
  it('mixed operations under one shared directory → 修改 <dir> 下 N 个文件', () => {
    const summary = summarizeChanges([
      change({ path: '/ws/src/auth/token.ts' }),
      change({ path: '/ws/src/auth/service.ts', operation: 'create', before: null, after: 'x\n' }),
      change({ path: '/ws/src/auth/api.ts' }),
    ])
    expect(summary).toBe('修改 src/auth 下 3 个文件')
  })

  it('create-only → 新增 <dir> 下 N 个文件', () => {
    const summary = summarizeChanges([
      change({ path: '/ws/src/lib/util.ts', operation: 'create', before: null, after: 'x\n' }),
      change({ path: '/ws/src/lib/helper.ts', operation: 'create', before: null, after: 'y\n' }),
    ])
    expect(summary).toBe('新增 src/lib 下 2 个文件')
  })

  it('delete-only → 删除 <dir> 下 N 个文件', () => {
    const summary = summarizeChanges([
      change({ path: '/ws/src/security/AuthConfig.java', operation: 'delete', before: 'x\n', after: null }),
    ])
    expect(summary).toBe('删除 src/security 下 1 个文件')
  })

  it('files in unrelated directories → no shared directory part', () => {
    const summary = summarizeChanges([
      change({ path: '/ws/src/a.ts' }),
      change({ path: '/ws/tests/b.spec.ts' }),
    ])
    expect(summary).toBe('修改 2 个文件')
  })

  it('files at the workspace root share no directory', () => {
    const summary = summarizeChanges([
      change({ path: '/ws/package.json' }),
      change({ path: '/ws/README.md' }),
    ])
    expect(summary).toBe('修改 2 个文件')
  })

  it('empty / command-only input → 无文件变更', () => {
    expect(summarizeChanges([])).toBe('无文件变更')
    expect(summarizeChanges([change({ kind: 'command', path: 'npm test', operation: 'execute', before: null, after: 'npm test' })])).toBe('无文件变更')
  })
})

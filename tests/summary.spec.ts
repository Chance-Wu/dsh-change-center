/**
 * summarizeChanges tests (3.x 摘要质量提升):shared heuristic priorities —
 * 单文件 → 单目录 → 双目录 → 混合. Host persistence and the client fallback
 * both use the same `models/sessionSummary.ts` implementation.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { summarizeChanges } from '../src/models/sessionSummary.ts'
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

describe('summarizeChanges (3.x)', () => {
  it('single file → 修改 <path> (no dir)', () => {
    expect(summarizeChanges([change({ path: '/ws/src/auth/LoginService.java' })])).toBe('修改 src/auth/LoginService.java')
  })

  it('single file at root → 修改 <name>', () => {
    expect(summarizeChanges([change({ path: '/ws/package.json' })])).toBe('修改 package.json')
  })

  it('multiple files under one directory → 修改 <dir> 下 N 个文件', () => {
    const summary = summarizeChanges([
      change({ path: '/ws/src/auth/token.ts' }),
      change({ path: '/ws/src/auth/service.ts', operation: 'create', before: null, after: 'x\n' }),
      change({ path: '/ws/src/auth/api.ts' }),
    ])
    expect(summary).toBe('修改 src/auth 下 3 个文件')
  })

  it('create-only under one directory → 新增 <dir> 下 N 个文件', () => {
    const summary = summarizeChanges([
      change({ path: '/ws/src/lib/util.ts', operation: 'create', before: null, after: 'x\n' }),
      change({ path: '/ws/src/lib/helper.ts', operation: 'create', before: null, after: 'y\n' }),
    ])
    expect(summary).toBe('新增 src/lib 下 2 个文件')
  })

  it('exactly two directories → 修改 <dirA> 和 <dirB> 下 N 个文件', () => {
    const summary = summarizeChanges([
      change({ path: '/ws/src/auth/a.ts' }),
      change({ path: '/ws/src/user/b.ts' }),
      change({ path: '/ws/src/user/c.ts' }),
    ])
    expect(summary).toBe('修改 src/auth 和 src/user 下 3 个文件')
  })

  it('three+ directories or root files → mixed 修改 N 个文件，包括 <first>', () => {
    expect(summarizeChanges([
      change({ path: '/ws/src/a.ts' }),
      change({ path: '/ws/tests/b.spec.ts' }),
      change({ path: '/ws/docs/c.md' }),
    ])).toBe('修改 3 个文件，包括 src/a.ts')
    expect(summarizeChanges([
      change({ path: '/ws/src/a.ts' }),
      change({ path: '/ws/package.json' }),
    ])).toBe('修改 2 个文件，包括 src/a.ts')
  })

  it('empty / command-only input → 无文件变更', () => {
    expect(summarizeChanges([])).toBe('无文件变更')
    expect(summarizeChanges([change({ kind: 'command', path: 'npm test', operation: 'execute', before: null, after: 'npm test' })])).toBe('无文件变更')
  })
})

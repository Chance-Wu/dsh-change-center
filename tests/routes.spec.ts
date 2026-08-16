/**
 * Route-table tests: parsePath resolves every change-center URL shape, and
 * list pagination clamps limit/offset to its bounds.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { parsePath, paginate } from '../src/api/routes.ts'

describe('parsePath', () => {
  it.each([
    ['/api/change-center/changes', { kind: 'changes' }],
    ['/api/change-center/changes/change-1', { kind: 'change', id: 'change-1' }],
    ['/api/change-center/changes/change-1/apply', { kind: 'not-found' }],
    ['/api/change-center/changes/change-1/rollback', { kind: 'change-action', id: 'change-1', action: 'rollback' }],
    ['/api/change-center/changes/change-1/restore', { kind: 'change-action', id: 'change-1', action: 'restore' }],
    ['/api/change-center/changes/change-1/edit', { kind: 'change-action', id: 'change-1', action: 'edit' }],
    ['/api/change-center/sessions', { kind: 'sessions' }],
    ['/api/change-center/sessions/s-1', { kind: 'session', id: 's-1' }],
    ['/api/change-center/sessions/s-1/changes', { kind: 'session-changes', id: 's-1' }],
    ['/api/change-center/sessions/s-1/reject-all', { kind: 'not-found' }],
    ['/api/change-center/sessions/s-1/apply-all', { kind: 'not-found' }],
    ['/api/change-center/sessions/s-1/rollback-all', { kind: 'session-action', id: 's-1', action: 'rollback-all' }],
    ['/api/change-center/sessions/s-1/git', { kind: 'git', id: 's-1', action: 'status' }],
    ['/api/change-center/sessions/s-1/git/diff', { kind: 'git', id: 's-1', action: 'diff' }],
    ['/api/change-center/sessions/s-1/git/log', { kind: 'git', id: 's-1', action: 'log' }],
    ['/api/change-center/sessions/s-1/git/add', { kind: 'git', id: 's-1', action: 'add' }],
    ['/api/change-center/sessions/s-1/git/commit', { kind: 'git', id: 's-1', action: 'commit' }],
    ['/api/change-center/sessions/s-1/git/push', { kind: 'git', id: 's-1', action: 'push' }],
    ['/api/change-center/sessions/s-1/verification', { kind: 'verification', id: 's-1', action: 'list' }],
    ['/api/change-center/sessions/s-1/verification/run', { kind: 'verification', id: 's-1', action: 'run' }],
    ['/api/change-center/sessions/s-1/review', { kind: 'review', id: 's-1', action: 'get' }],
    ['/api/change-center/sessions/s-1/review/run', { kind: 'review', id: 's-1', action: 'run' }],
    ['/api/change-center/sessions/s-1/risk', { kind: 'risk', id: 's-1', action: 'get' }],
    ['/api/change-center/sessions/s-1/risk/analyze', { kind: 'risk', id: 's-1', action: 'analyze' }],
    ['/api/change-center/sessions/s-1/history', { kind: 'history', id: 's-1', action: 'history' }],
    ['/api/change-center/sessions/s-1/history/timeline', { kind: 'history', id: 's-1', action: 'timeline' }],
    ['/api/change-center/sessions/s-1/fix', { kind: 'fix', id: 's-1', action: 'list' }],
    ['/api/change-center/sessions/s-1/fix/run', { kind: 'fix', id: 's-1', action: 'run' }],
    ['/api/change-center/sessions/s-1/loop/run', { kind: 'loop', id: 's-1' }],
    ['/api/change-center/sessions/s-1/policy-evaluation', { kind: 'policy-evaluation', id: 's-1' }],
    ['/api/change-center/sessions/s-1/jobs', { kind: 'session-jobs', id: 's-1' }],
    ['/api/change-center/jobs/job-1', { kind: 'job', id: 'job-1' }],
    ['/api/change-center/jobs/job-1/cancel', { kind: 'job-action', id: 'job-1', action: 'cancel' }],
    ['/api/change-center/events', { kind: 'events' }],
    ['/api/change-center/policies', { kind: 'policies', action: 'list' }],
    ['/api/change-center/policies/p-1/update', { kind: 'policy', id: 'p-1', action: 'update' }],
    ['/api/change-center/policies/p-1/delete', { kind: 'policy', id: 'p-1', action: 'delete' }],
  ])('parses %s', (path, expected) => {
    expect(parsePath(path)).toEqual(expected)
  })

  it('returns not-found for unknown shapes', () => {
    expect(parsePath('/api/change-center/nope')).toEqual({ kind: 'not-found' })
    expect(parsePath('/api/change-center/sessions/s-1/git/statuss')).toEqual({ kind: 'not-found' })
    expect(parsePath('/api/change-center/changes/c-1/bogus')).toEqual({ kind: 'not-found' })
    expect(parsePath('/api/change-center/sessions/s-1/loop')).toEqual({ kind: 'not-found' })
  })
})

describe('paginate', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('applies the default limit when no params are given', () => {
    expect(paginate(items, new URL('http://x/changes'))).toHaveLength(10)
  })

  it('respects limit and offset', () => {
    expect(paginate(items, new URL('http://x/changes?limit=3&offset=4'))).toEqual([5, 6, 7])
  })

  it('clamps limit to bounds', () => {
    expect(paginate(items, new URL('http://x/changes?limit=9999'))).toHaveLength(10)
    expect(paginate(items, new URL('http://x/changes?limit=0'))).toHaveLength(1)
  })

  it('ignores non-numeric params', () => {
    expect(paginate(items, new URL('http://x/changes?limit=abc&offset=x'))).toHaveLength(10)
  })
})

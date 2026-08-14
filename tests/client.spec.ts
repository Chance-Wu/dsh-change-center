/**
 * Client unit tests: pure tree/grouping helpers and the JobHandle
 * submit → poll → cancel flow (fetch stubbed).
 * @module dsh-change-center/tests
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { relativePath, extensionOf, groupByExtension, dedupeByPath } from '../src/client/ChangeTree.tsx'
import { submitJobHandle } from '../src/client/index.ts'
import type { WireChange } from '../src/client/index.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Build a minimal file change for pure-function tests. */
function change(over: Partial<WireChange> = {}): WireChange {
  return {
    id: 'c1', sessionId: 's1', cwd: '/ws', kind: 'file', path: '/ws/src/a.ts',
    operation: 'modify', before: 'x\n', after: 'y\n', diff: '-x\n+y\n',
    status: 'pending', source: 'agent', toolName: 'edit', createdAt: 0, updatedAt: 0,
    ...over,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('relativePath', () => {
  it('strips the workspace prefix (with or without trailing slash)', () => {
    expect(relativePath({ path: '/ws/src/a.ts', cwd: '/ws' })).toBe('src/a.ts')
    expect(relativePath({ path: '/ws/a.ts', cwd: '/ws/' })).toBe('a.ts')
  })

  it('returns the path verbatim when outside the workspace or cwd is empty', () => {
    expect(relativePath({ path: '/other/b.ts', cwd: '/ws' })).toBe('/other/b.ts')
    expect(relativePath({ path: '/ws2/c.ts', cwd: '/ws' })).toBe('/ws2/c.ts')
    expect(relativePath({ path: 'rel/d.ts', cwd: '' })).toBe('rel/d.ts')
  })
})

describe('extensionOf', () => {
  it('extracts the extension after the last dot', () => {
    expect(extensionOf('src/a.tsx')).toBe('tsx')
    expect(extensionOf('dir/file.min.js')).toBe('js')
  })

  it('returns empty for no extension or a leading dot', () => {
    expect(extensionOf('readme')).toBe('')
    expect(extensionOf('.hidden')).toBe('')
  })
})

describe('groupByExtension', () => {
  it('merges by extension with `*.ext` labels and aggregate counts', () => {
    const groups = groupByExtension([
      change({ path: '/ws/src/a.ts', before: '1\n', after: '2\n' }),
      change({ path: '/ws/src/b.ts', before: 'x\n', after: 'x\ny\nz\n' }),
    ])
    expect(groups.map(group => group.label)).toEqual(['*.ts'])
    expect(groups[0]?.changes).toHaveLength(2)
    expect(groups[0]?.additions).toBe(3)
    expect(groups[0]?.deletions).toBe(1)
  })

  it('groups extensionless files under (其他), sorted with ext groups', () => {
    const groups = groupByExtension([
      change({ path: '/ws/readme', before: 'a\nb\n', after: 'a\n' }),
      change({ path: '/ws/src/a.ts' }),
    ])
    // localeCompare: '(' (0x28) precedes '*' (0x2A), so (其他) sorts first.
    expect(groups.map(group => group.label)).toEqual(['(其他)', '*.ts'])
    expect(groups[0]?.additions).toBe(0)
    expect(groups[0]?.deletions).toBe(1)
  })
})

describe('dedupeByPath', () => {
  it('keeps the first (latest) change per path and drops duplicates', () => {
    const latest = change({ id: 'c2', path: '/ws/src/a.ts', status: 'applied' })
    const older = change({ id: 'c1', path: '/ws/src/a.ts' })
    const other = change({ id: 'c3', path: '/ws/src/b.ts' })
    // 列表为最新在前;去重后同路径只保留首个。
    const deduped = dedupeByPath([latest, older, other])
    expect(deduped.map(c => c.id)).toEqual(['c2', 'c3'])
  })
})

describe('submitJobHandle', () => {
  it('submits, polls to completion, and unwraps the result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ job: { status: 'running' } }))
      .mockResolvedValueOnce(jsonResponse({ job: { status: 'completed', result: 42 } }))
    vi.stubGlobal('fetch', fetchMock)

    const handle = await submitJobHandle(
      () => Promise.resolve({ job: { id: 'job-1' } }),
      job => job.result as number,
    )
    expect(handle.jobId).toBe('job-1')
    await expect(handle.done).resolves.toBe(42)
  })

  it('rejects on job failure with the job error message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ job: { status: 'running' } }))
      .mockResolvedValueOnce(jsonResponse({ job: { status: 'failed', error: 'kaboom' } }))
    vi.stubGlobal('fetch', fetchMock)

    const handle = await submitJobHandle(
      () => Promise.resolve({ job: { id: 'j1' } }),
      () => undefined,
    )
    await expect(handle.done).rejects.toThrow('kaboom')
  })

  it('cancel posts to the jobs endpoint; done rejects with cancelled', async () => {
    let cancelled = false
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/cancel')) {
        cancelled = true
        return Promise.resolve(jsonResponse({ job: { status: 'cancelled' } }))
      }
      return Promise.resolve(jsonResponse({ job: { status: cancelled ? 'cancelled' : 'running' } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const handle = await submitJobHandle(
      () => Promise.resolve({ job: { id: 'j1' } }),
      () => undefined,
    )
    const cancelPromise = handle.cancel()
    await expect(handle.done).rejects.toThrow('cancelled')
    await cancelPromise

    const postCalls = fetchMock.mock.calls.filter(call => String((call[1] as RequestInit | undefined)?.method) === 'POST')
    expect(postCalls.length).toBeGreaterThan(0)
    expect(String(postCalls[0]?.[0])).toContain('/jobs/j1/cancel')
  })
})

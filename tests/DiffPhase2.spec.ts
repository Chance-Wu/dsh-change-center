/**
 * Phase-2 unit tests: diff counting, side-by-side rows, and the session
 * turn lifecycle.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { countDiff, sideBySideRows } from '../src/services/DiffService.ts'

describe('countDiff', () => {
  it('counts additions and deletions', () => {
    const before = 'a\nb\nc\n'
    const after = 'a\nb\nx\ny\n'
    expect(countDiff(before, after)).toEqual({ additions: 2, deletions: 1 })
  })

  it('reports zero for identical text', () => {
    expect(countDiff('a\n', 'a\n')).toEqual({ additions: 0, deletions: 0 })
  })

  it('treats null as empty (create is all additions)', () => {
    expect(countDiff(null, 'l1\nl2\n')).toEqual({ additions: 2, deletions: 0 })
  })
})

describe('sideBySideRows', () => {
  it('aligns context rows with both texts', () => {
    const rows = sideBySideRows('a\nc\n', 'a\nb\nc\n')
    expect(rows[0]).toEqual({ insertion: false, deletion: false, before: 'a', after: 'a', beforeNo: 1, afterNo: 1 })
    expect(rows[1]).toEqual({ insertion: true, deletion: false, after: 'b', afterNo: 2 })
    expect(rows[2]).toEqual({ insertion: false, deletion: false, before: 'c', after: 'c', beforeNo: 2, afterNo: 3 })
  })

  it('marks deletions with only before', () => {
    const rows = sideBySideRows('a\nb\n', 'a\n')
    expect(rows[1]).toEqual({ insertion: false, deletion: true, before: 'b', beforeNo: 2 })
  })
})

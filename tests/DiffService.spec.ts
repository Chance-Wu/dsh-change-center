/**
 * DiffService unit tests: LCS diff correctness on line edits.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { diffLines, renderUnified } from '../src/services/DiffService.ts'

describe('diffLines', () => {
  it('reports no changes for identical text', () => {
    const lines = diffLines('a\nb\n', 'a\nb\n')
    expect(lines).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'context', text: 'b' },
    ])
  })

  it('detects an insertion', () => {
    const lines = diffLines('a\nc\n', 'a\nb\nc\n')
    expect(lines).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'ins', text: 'b' },
      { kind: 'context', text: 'c' },
    ])
  })

  it('detects a deletion', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nc\n')
    expect(lines).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'context', text: 'c' },
    ])
  })

  it('detects a substitution as del+ins', () => {
    const lines = diffLines('return mapper.selectById(id);\n', 'return mapper.findById(id);\n')
    expect(lines).toEqual([
      { kind: 'del', text: 'return mapper.selectById(id);' },
      { kind: 'ins', text: 'return mapper.findById(id);' },
    ])
  })

  it('treats null as empty (create)', () => {
    const lines = diffLines(null, 'hello\n')
    expect(lines).toEqual([{ kind: 'ins', text: 'hello' }])
  })

  it('handles CRLF normalization', () => {
    const lines = diffLines('a\r\nb\r\n', 'a\nc\n')
    expect(lines).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'ins', text: 'c' },
    ])
  })

  it('falls back to replace-all for oversized files (no LCS blow-up)', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old-${i}`).join('\n') + '\n'
    const after = Array.from({ length: 3000 }, (_, i) => `new-${i}`).join('\n') + '\n'
    const lines = diffLines(before, after)
    expect(lines.filter(line => line.kind === 'del')).toHaveLength(3000)
    expect(lines.filter(line => line.kind === 'ins')).toHaveLength(3000)
    expect(lines.some(line => line.kind === 'context')).toBe(false)
  })
})

describe('renderUnified', () => {
  it('renders minus/plus prefixes', () => {
    const text = renderUnified('old line\n', 'new line\n')
    expect(text).toContain('-old line')
    expect(text).toContain('+new line')
  })

  it('renders a no-changes marker for identical text', () => {
    expect(renderUnified('same\n', 'same\n')).toBe('(no changes)')
  })
})

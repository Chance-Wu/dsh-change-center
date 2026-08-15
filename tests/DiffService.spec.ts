/**
 * DiffService unit tests: LCS diff correctness on line edits.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { diffLines, renderUnified, diffHunks, applyHunks } from '../src/services/DiffService.ts'

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

describe('diffHunks', () => {
  it('splits separated change blocks into distinct hunks', () => {
    const hunks = diffHunks('a\nb\nc\nd\ne\nf\n', 'A\nb\nc\nD\ne\nf\n')
    expect(hunks).toHaveLength(2)
    // hunk0: 行1 a→A;hunk1: 行4 d→D。
    expect(hunks[0]).toMatchObject({ index: 0, beforeStart: 1, beforeLines: ['a'], afterLines: ['A'] })
    expect(hunks[1]).toMatchObject({ index: 1, beforeStart: 4, beforeLines: ['d'], afterLines: ['D'] })
  })

  it('handles a pure insertion hunk (beforeStart points at the insertion point)', () => {
    const hunks = diffHunks('a\nb\n', 'a\nX\ny\nb\n')
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ index: 0, beforeStart: 2, beforeLines: [], afterLines: ['X', 'y'] })
  })

  it('handles a pure deletion hunk', () => {
    const hunks = diffHunks('a\nX\nb\n', 'a\nb\n')
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ index: 0, beforeStart: 2, beforeLines: ['X'], afterLines: [] })
  })
})

describe('applyHunks (逐块接受重构)', () => {
  const before = 'a\nb\nc\nd\ne\nf\n'
  const after = 'A\nb\nc\nD\ne\nf\n'

  it('no hunk applied → before content', () => {
    const hunks = diffHunks(before, after)
    expect(applyHunks(before, hunks, [false, false])).toBe(before)
  })

  it('all hunks applied → after content (初始状态:捕获后文件=after)', () => {
    const hunks = diffHunks(before, after)
    expect(applyHunks(before, hunks, [true, true])).toBe(after)
  })

  it('only hunk0 applied → 逐块接受:该块生效,其余保持 before', () => {
    const hunks = diffHunks(before, after)
    expect(applyHunks(before, hunks, [true, false])).toBe('A\nb\nc\nd\ne\nf\n')
  })

  it('revert hunk0 (应用后撤销)→ 仅 hunk1 保持应用', () => {
    const hunks = diffHunks(before, after)
    expect(applyHunks(before, hunks, [false, true])).toBe('a\nb\nc\nD\ne\nf\n')
  })

  it('preserves the trailing newline of before', () => {
    const hunks = diffHunks('a\nb\n', 'A\nb\n')
    expect(applyHunks('a\nb\n', hunks, [true])).toBe('A\nb\n')
  })
})

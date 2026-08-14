/**
 * Phase-3 unit tests: risk rules, review JSON parsing, verification command
 * detection, and history event recording.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { parseReviewJson } from '../src/review/AIReviewService.ts'
import { countDeletions } from '../src/risk/RiskService.ts'

describe('parseReviewJson', () => {
  let nextId = 0
  const mint = (): string => `f${++nextId}`

  it('parses a clean JSON review', () => {
    const text = JSON.stringify({
      risk: 'high',
      score: 78,
      summary: 'permission logic changed',
      findings: [{
        severity: 'warning', file: 'UserService.java', line: 87,
        title: 'Missing auth', description: 'No check', suggestion: 'add one',
      }],
    })
    const result = parseReviewJson(text, 'sess-1', mint)
    expect(result.risk).toBe('high')
    expect(result.score).toBe(78)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      severity: 'warning', filePath: 'UserService.java', line: 87, title: 'Missing auth',
    })
  })

  it('strips markdown fences', () => {
    const text = '```json\n{"risk":"low","score":90,"summary":"ok","findings":[]}\n```'
    const result = parseReviewJson(text, 'sess-1', mint)
    expect(result.risk).toBe('low')
    expect(result.score).toBe(90)
  })

  it('tolerates trailing prose after JSON', () => {
    const text = '{"risk":"medium","score":55,"summary":"s","findings":[]}\n\nThat covers the main issues.'
    const result = parseReviewJson(text, 'sess-1', mint)
    expect(result.risk).toBe('medium')
  })

  it('falls back to an error finding on unparseable output', () => {
    const result = parseReviewJson('the changes look fine to me', 'sess-1', mint)
    expect(result.findings[0]?.severity).toBe('error')
    expect(result.findings[0]?.title).toContain('parse failure')
  })

  it('normalizes bad severity/score', () => {
    const result = parseReviewJson(
      JSON.stringify({ risk: 'nonsense', score: 999, summary: 'x', findings: [{ severity: 'bogus' }] }),
      'sess-1', mint,
    )
    expect(result.risk).toBe('medium')
    expect(result.score).toBe(100)
    expect(result.findings[0]?.severity).toBe('info')
  })
})

describe('RiskService deletion counting', () => {
  it('counts - prefixed lines in a unified diff', () => {
    const diff = '-old\n+new\n-removed\n context\n'
    expect(countDeletions(diff)).toBe(2)
  })

  it('ignores the --- file header separator', () => {
    const diff = '--- a/x\n+++ b/x\n-old\n+new\n'
    expect(countDeletions(diff)).toBe(1)
  })
})

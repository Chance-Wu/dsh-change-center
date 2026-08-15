/**
 * actionsFor matrix tests: the per-change action availability table mirrors
 * the host state machine, so the review bar and the tree stay consistent.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { actionsFor } from '../src/client/changeActions.ts'

describe('actionsFor', () => {
  it('pending: apply only（5.x 主路径即应用，不再提供接受/拒绝）', () => {
    expect(actionsFor('pending')).toEqual({
      canApply: true,
      canRetryApply: false, canRollback: false, canRepend: false,
    })
  })

  it('approved: apply only（历史 approved 状态仍可应用）', () => {
    expect(actionsFor('approved')).toEqual({
      canApply: true,
      canRetryApply: false, canRollback: false, canRepend: false,
    })
  })

  it('failed: retryApply only', () => {
    expect(actionsFor('failed')).toEqual({
      canApply: false,
      canRetryApply: true, canRollback: false, canRepend: false,
    })
  })

  it('applied: rollback only', () => {
    expect(actionsFor('applied')).toEqual({
      canApply: false,
      canRetryApply: false, canRollback: true, canRepend: false,
    })
  })

  it('rejected / rolled_back: repend only (no dead ends)', () => {
    const expected = {
      canApply: false,
      canRetryApply: false, canRollback: false, canRepend: true,
    }
    expect(actionsFor('rejected')).toEqual(expected)
    expect(actionsFor('rolled_back')).toEqual(expected)
  })
})

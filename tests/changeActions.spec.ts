/**
 * actionsFor matrix tests: the per-change action availability table mirrors
 * the 4-state apply↔rollback machine, so the review bar and the tree stay
 * consistent.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { actionsFor } from '../src/client/changeActions.ts'

describe('actionsFor (应用↔回滚双操作模型)', () => {
  it('pending: apply only', () => {
    expect(actionsFor('pending')).toEqual({
      canApply: true, canRetryApply: false, canRollback: false, canReapply: false,
    })
  })

  it('failed: retryApply only', () => {
    expect(actionsFor('failed')).toEqual({
      canApply: false, canRetryApply: true, canRollback: false, canReapply: false,
    })
  })

  it('applied: rollback only', () => {
    expect(actionsFor('applied')).toEqual({
      canApply: false, canRetryApply: false, canRollback: true, canReapply: false,
    })
  })

  it('rolled_back: reapply only (no dead ends)', () => {
    expect(actionsFor('rolled_back')).toEqual({
      canApply: false, canRetryApply: false, canRollback: false, canReapply: true,
    })
  })
})

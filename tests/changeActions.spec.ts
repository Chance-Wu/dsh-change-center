/**
 * actionsFor matrix tests: the per-change action availability table mirrors
 * the host state machine, so the review bar and the tree stay consistent.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { actionsFor } from '../src/client/changeActions.ts'

describe('actionsFor', () => {
  it('pending: approve / reject / apply', () => {
    expect(actionsFor('pending')).toEqual({
      canApprove: true, canReject: true, canApply: true,
      canRetryApply: false, canRollback: false, canRepend: false,
    })
  })

  it('approved: reject / apply', () => {
    expect(actionsFor('approved')).toEqual({
      canApprove: false, canReject: true, canApply: true,
      canRetryApply: false, canRollback: false, canRepend: false,
    })
  })

  it('failed: reject / retryApply (no approve — bulk already accepted)', () => {
    expect(actionsFor('failed')).toEqual({
      canApprove: false, canReject: true, canApply: false,
      canRetryApply: true, canRollback: false, canRepend: false,
    })
  })

  it('applied: rollback only', () => {
    expect(actionsFor('applied')).toEqual({
      canApprove: false, canReject: false, canApply: false,
      canRetryApply: false, canRollback: true, canRepend: false,
    })
  })

  it('rejected / rolled_back: repend only (no dead ends)', () => {
    const expected = {
      canApprove: false, canReject: false, canApply: false,
      canRetryApply: false, canRollback: false, canRepend: true,
    }
    expect(actionsFor('rejected')).toEqual(expected)
    expect(actionsFor('rolled_back')).toEqual(expected)
  })
})

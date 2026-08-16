/**
 * actionsFor matrix tests: the per-change action availability table mirrors
 * the 5.x state machine (capture 即登记,无「应用」—— 只剩 回滚/恢复),
 * so the review bar and the tree stay consistent.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { actionsFor } from '../src/client/changeActions.ts'

describe('actionsFor (capture 即登记,回滚⇄恢复)', () => {
  it('applied: rollback only', () => {
    expect(actionsFor('applied')).toEqual({
      canRollback: true, canReapply: false,
    })
  })

  it('rolled_back: restore only (no dead ends)', () => {
    expect(actionsFor('rolled_back')).toEqual({
      canRollback: false, canReapply: true,
    })
  })

  it('pending / failed: 历史状态,无操作', () => {
    expect(actionsFor('pending')).toEqual({ canRollback: false, canReapply: false })
    expect(actionsFor('failed')).toEqual({ canRollback: false, canReapply: false })
  })
})

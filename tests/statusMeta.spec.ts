/**
 * statusMeta tests (Vibe UI V-8): the status → icon/label/weight table keeps
 * the four apply↔rollback statuses readable without touching the machine.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { statusMeta } from '../src/client/statusMeta.ts'

describe('statusMeta (应用↔回滚 4 状态)', () => {
  it('maps every status to icon + label + weight (applied high, rolled_back low)', () => {
    expect(statusMeta('pending')).toEqual({ icon: '○', label: '待处理', weight: 'normal' })
    expect(statusMeta('applied')).toEqual({ icon: '✓', label: '已应用', weight: 'high' })
    expect(statusMeta('rolled_back')).toEqual({ icon: '↶', label: '已回滚', weight: 'low' })
    expect(statusMeta('failed')).toEqual({ icon: '!', label: '应用失败', weight: 'high' })
  })
})

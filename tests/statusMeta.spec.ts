/**
 * statusMeta tests (Vibe UI V-8): the status → icon/label/weight table keeps
 * the six state-machine statuses readable without touching the machine itself.
 * @module dsh-change-center/tests
 */

import { describe, expect, it } from 'vitest'
import { statusMeta } from '../src/client/statusMeta.ts'

describe('statusMeta', () => {
  it('maps every status to icon + label + weight (applied high, rejected/rolled_back low)', () => {
    expect(statusMeta('pending')).toEqual({ icon: '●', label: '待处理', weight: 'normal' })
    expect(statusMeta('approved')).toEqual({ icon: '●', label: '已接受', weight: 'normal' })
    expect(statusMeta('applied')).toEqual({ icon: '✓', label: '已应用', weight: 'high' })
    expect(statusMeta('rejected')).toEqual({ icon: '×', label: '已拒绝', weight: 'low' })
    expect(statusMeta('rolled_back')).toEqual({ icon: '↶', label: '已回滚', weight: 'low' })
    expect(statusMeta('failed')).toEqual({ icon: '!', label: '应用失败', weight: 'high' })
  })
})

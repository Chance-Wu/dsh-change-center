/**
 * 3.x behavior contracts: the six contract groups the plan calls for —
 * state machine / apply / rollback / batch / SSE / editor — plus one golden
 * flow. These pin behavior, not feature counts.
 *
 * A. 状态机契约:actionsFor 与共享 CHANGE_STATE 完全一致;非法转移返回结构化错误。
 * B. Apply 契约:hash 冲突 → failed + 外部修改;force 绕过。
 * C. Rollback 契约:缺快照 → missing-snapshot,状态保持 applied(绝不误标 rolled_back)。
 * D. Batch 契约:结果计数互斥且覆盖全部变更。
 * E. SSE 契约:统一事件名在正确时机触发。
 * F. Editor 契约:edit → diff 重算 → apply 写入的是编辑后的内容(绝不是原始 after)。
 * G. 黄金流程:capture → review → apply → 校验 → rollback → 校验恢复。
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SessionStore, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'
import { ApplyService } from '../src/services/ApplyService.ts'
import { SnapshotService } from '../src/services/SnapshotService.ts'
import { PolicyService } from '../src/policy/PolicyService.ts'
import { CHANGE_ACTIONS, CHANGE_TRANSITIONS, canTransition, type ChangeAction } from '../src/models/ChangeState.ts'
import { actionsFor } from '../src/client/changeActions.ts'
import type { ChangeStatus } from '../src/models/FileChange.ts'
import { removeDirSafe } from './helpers/removeDir.ts'

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-contracts-'))
  process.env.DSH_HOME = join(tempDir, 'dsh-home')
})

afterAll(async () => {
  delete process.env.DSH_HOME
  await removeDirSafe(tempDir)
})

/** Real fs + apply/snapshot engines + policy; changes recorded directly. */
async function fullSetup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: tempDir })
  await ctx.plugin(ChangeService)
  await ctx.plugin(SessionService)
  await ctx.plugin(ApplyService)
  await ctx.plugin(SnapshotService)
  await ctx.plugin(PolicyService)
  return ctx
}

function recordFile(ctx: Context, sessionId: string, path: string, over: Partial<{
  operation: string
  before: string | null
  after: string | null
  cwd: string
}> = {}): string {
  const change = ctx.changeCenter.record({
    sessionId,
    cwd: over.cwd ?? tempDir,
    kind: 'file',
    path,
    operation: (over.operation ?? 'modify') as 'modify',
    before: over.before ?? 'original\n',
    after: over.after ?? 'changed\n',
    source: 'agent',
    toolName: 'edit',
  })
  return change.id
}

describe('A. 状态机契约', () => {
  it('actionsFor 与共享 CHANGE_STATE 完全一致,且每个操作都有合法转移', () => {
    const actionTarget: Record<ChangeAction, ChangeStatus> = {
      approve: 'approved',
      reject: 'rejected',
      apply: 'applied',
      'retry-apply': 'applied',
      rollback: 'rolled_back',
      repend: 'pending',
    }
    for (const status of Object.keys(CHANGE_ACTIONS) as ChangeStatus[]) {
      const actions = CHANGE_ACTIONS[status]
      const matrix = actionsFor(status)
      expect(matrix.canApprove).toBe(actions.includes('approve'))
      expect(matrix.canReject).toBe(actions.includes('reject'))
      expect(matrix.canApply).toBe(actions.includes('apply'))
      expect(matrix.canRetryApply).toBe(actions.includes('retry-apply'))
      expect(matrix.canRollback).toBe(actions.includes('rollback'))
      expect(matrix.canRepend).toBe(actions.includes('repend'))
      for (const action of actions) {
        expect(canTransition(status, actionTarget[action]), `${status} → ${action}`).toBe(true)
      }
    }
  })

  it('TRANSITIONS 表是 CHANGE_TRANSITIONS 的同一事实源', () => {
    // CHANGE_TRANSITIONS 必须覆盖全部六个状态且每个目标合法可查。
    for (const status of Object.keys(CHANGE_TRANSITIONS) as ChangeStatus[]) {
      for (const target of CHANGE_TRANSITIONS[status]) {
        expect(canTransition(status, target)).toBe(true)
      }
    }
  })

  it('host 拒绝非法转移并返回结构化错误(不抛 500)', async () => {
    const ctx = new Context()
    await ctx.plugin(ChangeService)
    const id = ctx.changeCenter.record({
      sessionId: 's', cwd: tempDir, path: 'a.txt', operation: 'modify',
      before: 'x\n', after: 'y\n', source: 'agent', toolName: 'edit',
    }).id
    expect(ctx.changeCenter.approve(id)).not.toBeNull()
    const again = ctx.changeCenter.approve(id)
    expect(again).toMatchObject({ kind: 'error' })
    // applied 状态不能 approve / reject。
    const applied = ctx.changeCenter.get(id)
    expect(applied?.status).toBe('approved')
  })
})

describe('B + C. Apply / Rollback 契约(真实文件系统)', () => {
  it('apply 写入编辑后的内容(editor 契约:edit → diff 重算 → apply 写入新版本,无假冲突)', async () => {
    const ctx = await fullSetup()
    const target = join(tempDir, 'editor.txt')
    // 捕获发生在工具写盘之后:磁盘 = after(已知基线)。
    writeFileSync(target, 'changed\n')
    const id = recordFile(ctx, 'editor-1', target)
    // 用户编辑:Draft → Save → after 更新,diff 重算(基线不变)。
    ctx.changeCenter.edit(id, 'user edited\n')
    const change = ctx.changeCenter.get(id)!
    expect(change.diff).toContain('user edited')
    // Apply 必须写入编辑后的版本,且不被误判为外部修改。
    const outcome = await ctx.changeCenter.apply(id)
    expect(outcome.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('user edited\n')
  })

  it('hash 冲突 → failed + 外部修改,不覆盖磁盘(force 才绕过)', async () => {
    const ctx = await fullSetup()
    const target = join(tempDir, 'conflict.txt')
    writeFileSync(target, 'changed\n')
    const id = recordFile(ctx, 'conflict-1', target)
    // 磁盘被外部修改(≠ 已知基线)。
    writeFileSync(target, 'external edit\n')
    const outcome = await ctx.changeCenter.apply(id)
    expect(outcome).toMatchObject({ kind: 'conflict' })
    expect(ctx.changeCenter.get(id)?.status).toBe('failed')
    expect(readFileSync(target, 'utf8')).toBe('external edit\n')
    const forced = await ctx.changeCenter.apply(id, true)
    expect(forced.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('changed\n')
  })

  it('回滚缺快照 → missing-snapshot,状态保持 applied(绝不误标 rolled_back)', async () => {
    const ctx = await fullSetup()
    const target = join(tempDir, 'rollback-missing.txt')
    writeFileSync(target, 'changed\n')
    const id = recordFile(ctx, 'rollback-1', target)
    await ctx.changeCenter.apply(id)
    expect(ctx.changeCenter.get(id)?.status).toBe('applied')
    // 删除快照模拟丢失。
    const snapRoot = join(process.env.DSH_HOME!, 'change-center', 'snapshots', 'rollback-1', id)
    rmSync(snapRoot, { recursive: true, force: true })
    const outcome = await ctx.changeCenter.rollback(id)
    expect(outcome.kind).toBe('missing-snapshot')
    expect(ctx.changeCenter.get(id)?.status).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('changed\n')
  })
})

describe('D. Batch 契约', () => {
  it('结果计数互斥且覆盖全部变更(最新胜出/superseded/deny/skipped)', async () => {
    const ctx = await fullSetup()
    const sessionId = 'batch-1'
    // c1(旧):同路径旧写入 → superseded;c2(新):待审正常 → applied;
    // c3:命中 deny(src/security 删除)→ blocked;c4:已 approved → skipped。
    const appTarget = join(tempDir, 'app.ts')
    writeFileSync(appTarget, 'changed\n')
    const c1 = recordFile(ctx, sessionId, appTarget, { before: 'old\n', after: 'older\n' })
    const c2 = recordFile(ctx, sessionId, appTarget)
    const c3 = recordFile(ctx, sessionId, join(tempDir, 'src', 'security', 'Config.java'), { operation: 'delete', before: 'x\n', after: null })
    const c4 = recordFile(ctx, sessionId, join(tempDir, 'skip.ts'))
    ctx.changeCenter.approve(c4)

    const result = await ctx.changeCenter.acceptAllAndApply(sessionId)
    const all = [...result.applied, ...result.failed.map(f => f.id), ...result.blocked.map(b => b.id), ...result.skipped, ...result.superseded]
    // 互斥:无重复。
    expect(new Set(all).size).toBe(all.length)
    // 覆盖:全部 4 个变更恰好出现在一个桶里。
    expect(all).toHaveLength(4)
    expect(all.sort()).toEqual([c1, c2, c3, c4].sort())
    // 语义:c1(旧)superseded,c2(新)applied,c3 deny → blocked,c4 skipped。
    expect(result.applied).toContain(c2)
    expect(result.superseded).toContain(c1)
    expect(result.blocked.some(b => b.id === c3)).toBe(true)
    expect(result.skipped).toContain(c4)
  })
})

describe('E. SSE 契约', () => {
  it('统一事件名在正确时机触发(change.updated / session.created / session.completed)', async () => {
    const ctx = await fullSetup()
    await ctx.plugin(SessionStore)
    // 先记录变更(会触发 fallback session 的 session.created,不计入断言)。
    const id = recordFile(ctx, 'sse-1', join(tempDir, 'sse.txt'))
    const updated: string[] = []
    const created: string[] = []
    const completed: string[] = []
    ctx.on('change.updated', (change: { status: string }) => { updated.push(change.status) })
    ctx.on('session.created', () => { created.push('x') })
    ctx.on('session.completed', () => { completed.push('x') })

    ctx.changeCenter.reject(id)
    expect(updated).toEqual(['rejected'])

    const session = ctx.sessions.create(SessionId('sse-agent'), {
      meta: { cwd: tempDir, createdAt: Date.now() },
    })
    session.append('turn/start', { turn: 1 })
    expect(created).toHaveLength(1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(completed).toHaveLength(1)
  })
})

describe('F. 黄金流程', () => {
  it('capture → review → apply → 校验 → rollback → 校验恢复(一条线性流程)', async () => {
    const ctx = await fullSetup()
    const sessionId = 'golden-1'
    const a = join(tempDir, 'a.txt')
    const b = join(tempDir, 'b.txt')
    // 捕获后磁盘 = after。
    writeFileSync(a, 'changed\n')
    writeFileSync(b, 'changed\n')
    const idA = recordFile(ctx, sessionId, a, { before: 'a1\n' })
    const idB = recordFile(ctx, sessionId, b, { before: 'b1\n' })

    // review:接受两个变更。
    ctx.changeCenter.approve(idA)
    ctx.changeCenter.approve(idB)
    // apply:单条应用(approved → apply)。
    expect((await ctx.changeCenter.apply(idA)).kind).toBe('applied')
    expect((await ctx.changeCenter.apply(idB)).kind).toBe('applied')
    expect(readFileSync(a, 'utf8')).toBe('changed\n')
    expect(readFileSync(b, 'utf8')).toBe('changed\n')
    // undo/rollback:全部回滚 → 恢复 before。
    const rolled = await ctx.changeCenter.rollbackAll(sessionId)
    expect(rolled.rolledBack).toHaveLength(2)
    expect(readFileSync(a, 'utf8')).toBe('a1\n')
    expect(readFileSync(b, 'utf8')).toBe('b1\n')
  })
})

/**
 * 5.x behavior contracts:
 *
 * A. 状态机契约:actionsFor 与共享 CHANGE_STATE 完全一致;非法转移返回结构化错误。
 * B. 写盘契约:capture 即 applied(磁盘=after);编辑保存 saveEdit 一步写盘;
 *    hash 冲突 → conflict + 状态保持 applied(不覆盖,force 才绕过)。
 * C. Rollback 契约:缺快照 → missing-snapshot,状态保持 applied(绝不误标 rolled_back);
 *    回滚→恢复 闭环(diskBaseline 守卫不误判)。
 * D. Hunk 契约:块级撤销/应用/编辑写盘(与整体一致)。
 * E. SSE 契约:统一事件名在正确时机触发。
 * F. 黄金流程:capture → rollback → restore 一条线性流程。
 * @module dsh-change-center/tests
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { ChangeService } from '../src/services/ChangeService.ts'
import { SessionService } from '../src/services/SessionService.ts'
import { ApplyService } from '../src/services/ApplyService.ts'
import { SnapshotService } from '../src/services/SnapshotService.ts'
import { PolicyService } from '../src/policy/PolicyService.ts'
import { CHANGE_ACTIONS, CHANGE_TRANSITIONS, canTransition, type ChangeAction } from '../src/models/ChangeState.ts'
import { actionsFor } from '../src/client/changeActions.ts'
import type { ChangeStatus } from '../src/models/FileChange.ts'
import { removeDirSafe } from './helpers/removeDir.ts'
import { waitForSnapshot } from './helpers/waitSnapshot.ts'

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

describe('A. 状态机契约(capture 即登记,回滚⇄恢复)', () => {
  it('actionsFor 与共享 CHANGE_STATE 完全一致,且每个操作都有合法转移', () => {
    const actionTarget: Record<ChangeAction, ChangeStatus> = {
      apply: 'applied',
      rollback: 'rolled_back',
    }
    for (const status of Object.keys(CHANGE_ACTIONS) as ChangeStatus[]) {
      const actions = CHANGE_ACTIONS[status]
      const matrix = actionsFor(status)
      expect(matrix.canRollback).toBe(status === 'applied' && actions.includes('rollback'))
      expect(matrix.canReapply).toBe(status === 'rolled_back' && actions.includes('apply'))
      for (const action of actions) {
        expect(canTransition(status, actionTarget[action]), `${status} → ${action}`).toBe(true)
      }
    }
  })

  it('TRANSITIONS 表是 CHANGE_TRANSITIONS 的同一事实源', () => {
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
    // 5.x:applied 变更的「回滚」依赖快照,无快照服务 → 结构化错误(不抛)。
    const rolled = await ctx.changeCenter.rollback(id)
    expect(rolled).toMatchObject({ kind: 'error' })
    expect(ctx.changeCenter.get(id)?.status).toBe('applied')
  })
})

describe('B + C. 写盘 / Rollback 契约(真实文件系统)', () => {
  it('capture 即登记:record 后 status=applied、磁盘=after、diff 就绪', async () => {
    const ctx = await fullSetup()
    const target = join(tempDir, 'capture.txt')
    writeFileSync(target, 'changed\n')
    const id = recordFile(ctx, 'capture-1', target)
    const change = ctx.changeCenter.get(id)!
    expect(change.status).toBe('applied')
    expect(change.diskBaseline).toBe('changed\n')
    expect(change.diff).toContain('-original')
    expect(change.diff).toContain('+changed')
    expect(readFileSync(target, 'utf8')).toBe('changed\n')
  })

  it('编辑保存 saveEdit:diff 重算 → 一步写盘(基线不变不误判为外部修改)', async () => {
    const ctx = await fullSetup()
    const target = join(tempDir, 'editor.txt')
    writeFileSync(target, 'changed\n')
    const id = recordFile(ctx, 'editor-1', target)
    await waitForSnapshot('editor-1', id)
    // 用户编辑:Draft → Save → after 更新,diff 重算(基线不变) → 写盘。
    const outcome = await ctx.changeCenter.saveEdit(id, 'user edited\n')
    expect(outcome.kind).toBe('applied')
    expect(ctx.changeCenter.get(id)!.diff).toContain('user edited')
    expect(readFileSync(target, 'utf8')).toBe('user edited\n')
    expect(ctx.changeCenter.get(id)!.status).toBe('applied')
  })

  it('hash 冲突 → conflict,状态保持 applied 不覆盖磁盘(force 才绕过)', async () => {
    const ctx = await fullSetup()
    const target = join(tempDir, 'conflict.txt')
    writeFileSync(target, 'changed\n')
    const id = recordFile(ctx, 'conflict-1', target)
    // 磁盘被外部修改(≠ 已知基线)。
    writeFileSync(target, 'external edit\n')
    const outcome = await ctx.changeCenter.saveEdit(id, 'my edit\n')
    expect(outcome).toMatchObject({ kind: 'conflict' })
    expect(ctx.changeCenter.get(id)?.status).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('external edit\n')
    // force:明确选择覆盖。
    const forced = await ctx.changeCenter.saveEdit(id, 'my edit\n', true)
    expect(forced.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('my edit\n')
  })

  it('回滚缺快照 → missing-snapshot,状态保持 applied(绝不误标 rolled_back)', async () => {
    const ctx = await fullSetup()
    const target = join(tempDir, 'rollback-missing.txt')
    writeFileSync(target, 'changed\n')
    const id = recordFile(ctx, 'rollback-1', target)
    await waitForSnapshot('rollback-1', id)
    expect(ctx.changeCenter.get(id)?.status).toBe('applied')
    // 删除快照 marker(4.2 新布局)模拟丢失。
    const snapRoot = join(process.env.DSH_HOME!, 'change-center', 'snapshots', 'changes', 'rollback-1', id)
    rmSync(snapRoot, { recursive: true, force: true })
    const outcome = await ctx.changeCenter.rollback(id)
    expect(outcome.kind).toBe('missing-snapshot')
    expect(ctx.changeCenter.get(id)?.status).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('changed\n')
  })

  it('回滚→恢复 闭环(diskBaseline 守卫不误判外部修改)', async () => {
    const ctx = await fullSetup()
    const target = join(tempDir, 'cycle.txt')
    writeFileSync(target, 'changed\n')
    const id = recordFile(ctx, 'cycle-1', target, { before: 'original\n', after: 'changed\n' })
    await waitForSnapshot('cycle-1', id)
    // capture 即 applied。
    expect(ctx.changeCenter.get(id)?.status).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('changed\n')
    // 回滚:磁盘恢复 before,状态 rolled_back。
    const rolled = await ctx.changeCenter.rollback(id)
    expect(rolled.kind).toBe('rolled-back')
    expect(readFileSync(target, 'utf8')).toBe('original\n')
    expect(ctx.changeCenter.get(id)?.status).toBe('rolled_back')
    // 恢复:写回 agent 版本(after),守卫(磁盘=before=基线)不误判。
    const restored = await ctx.changeCenter.restore(id)
    expect(restored.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('changed\n')
    expect(ctx.changeCenter.get(id)?.status).toBe('applied')
  })

  it('hunk 级撤销/应用:撤销某块仅该区域恢复 before,其余块保持应用', async () => {
    const ctx = await fullSetup()
    const target = join(tempDir, 'hunks.txt')
    const before = 'a\nb\nc\nd\ne\nf\n'
    const after = 'A\nb\nc\nD\ne\nf\n'
    writeFileSync(target, after)
    const id = recordFile(ctx, 'hunk-1', target, { before, after })
    // 撤销 hunk0(行1 a→A):文件恢复 before 的 a,其余(hunk1 的 d→D)保持。
    const reverted = await ctx.changeCenter.applyHunk(id, 0, true)
    expect(reverted.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('a\nb\nc\nD\ne\nf\n')
    expect(ctx.changeCenter.get(id)?.hunkApplied).toEqual([false, true])
    // 重新应用 hunk0:文件回到完整 after。
    const reapplied = await ctx.changeCenter.applyHunk(id, 0, false)
    expect(reapplied.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe(after)
    expect(ctx.changeCenter.get(id)?.hunkApplied).toEqual([true, true])
    // 越界 index → 结构化错误。
    const bad = await ctx.changeCenter.applyHunk(id, 9, true)
    expect(bad).toMatchObject({ kind: 'error' })
  })

  it('editHunk:块内编辑写入用户修改后的行,撤销该块丢弃编辑', async () => {
    const ctx = await fullSetup()
    const target = join(tempDir, 'hunk-edit.txt')
    const before = 'a\nb\nc\nd\ne\nf\n'
    const after = 'A\nb\nc\nD\ne\nf\n'
    writeFileSync(target, after)
    const id = recordFile(ctx, 'hunk-edit', target, { before, after })
    // 编辑 hunk0(行1 a→A):写入用户修改后的两行。
    const edited = await ctx.changeCenter.editHunk(id, 0, ['a', 'Z'])
    expect(edited.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('a\nZ\nb\nc\nD\ne\nf\n')
    expect(ctx.changeCenter.get(id)?.hunkEdits?.[0]).toEqual(['a', 'Z'])
    expect(ctx.changeCenter.get(id)?.status).toBe('applied')
    // 撤销 hunk0:该区域恢复 before,且编辑被丢弃。
    const reverted = await ctx.changeCenter.applyHunk(id, 0, true)
    expect(reverted.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe('a\nb\nc\nD\ne\nf\n')
    expect(ctx.changeCenter.get(id)?.hunkApplied).toEqual([false, true])
    expect(ctx.changeCenter.get(id)?.hunkEdits?.[0]).toBeNull()
    // 重新应用 hunk0:回到原始 after(编辑已丢弃)。
    const reapplied = await ctx.changeCenter.applyHunk(id, 0, false)
    expect(reapplied.kind).toBe('applied')
    expect(readFileSync(target, 'utf8')).toBe(after)
    // 非法行(非字符串)→ 结构化错误。
    const bad = await ctx.changeCenter.editHunk(id, 0, ['ok', 42 as unknown as string])
    expect(bad).toMatchObject({ kind: 'error' })
  })
})

describe('E. SSE 契约', () => {
  it('统一事件名在正确时机触发(change.updated / session.created / session.completed)', async () => {
    const ctx = await fullSetup()
    await ctx.plugin(SessionStore)
    // 先记录变更(会触发 fallback session 的 session.created,不计入断言)。
    const target = join(tempDir, 'sse.txt')
    writeFileSync(target, 'changed\n')
    const id = recordFile(ctx, 'sse-1', target)
    await waitForSnapshot('sse-1', id)
    const updated: string[] = []
    const created: string[] = []
    const completed: string[] = []
    ctx.on('change.updated', (change: { status: string }) => { updated.push(change.status) })
    ctx.on('session.created', () => { created.push('x') })
    ctx.on('session.completed', () => { completed.push('x') })

    // 5.x:编辑保存(写盘)触发 change.updated(applied)。
    await ctx.changeCenter.saveEdit(id, 'user edit\n')
    expect(updated).toEqual(['applied'])

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
  it('capture → rollback → restore 一条线性流程', async () => {
    const ctx = await fullSetup()
    const sessionId = 'golden-1'
    const a = join(tempDir, 'a.txt')
    const b = join(tempDir, 'b.txt')
    // 捕获后磁盘 = after;capture 即 applied。
    writeFileSync(a, 'changed\n')
    writeFileSync(b, 'changed\n')
    const idA = recordFile(ctx, sessionId, a, { before: 'a1\n' })
    const idB = recordFile(ctx, sessionId, b, { before: 'b1\n' })
    await waitForSnapshot(sessionId, idA)
    await waitForSnapshot(sessionId, idB)
    expect(ctx.changeCenter.get(idA)?.status).toBe('applied')
    expect(ctx.changeCenter.get(idB)?.status).toBe('applied')
    expect(readFileSync(a, 'utf8')).toBe('changed\n')
    expect(readFileSync(b, 'utf8')).toBe('changed\n')
    // 全部回滚 → 恢复 before。
    const rolled = await ctx.changeCenter.rollbackAll(sessionId)
    expect(rolled.rolledBack).toHaveLength(2)
    expect(readFileSync(a, 'utf8')).toBe('a1\n')
    expect(readFileSync(b, 'utf8')).toBe('b1\n')
    // 逐条恢复 → 写回 agent 版本。
    expect((await ctx.changeCenter.restore(idA)).kind).toBe('applied')
    expect((await ctx.changeCenter.restore(idB)).kind).toBe('applied')
    expect(readFileSync(a, 'utf8')).toBe('changed\n')
    expect(readFileSync(b, 'utf8')).toBe('changed\n')
    expect(ctx.changeCenter.get(idA)?.status).toBe('applied')
    expect(ctx.changeCenter.get(idB)?.status).toBe('applied')
  })
})

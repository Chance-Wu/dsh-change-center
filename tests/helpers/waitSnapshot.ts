/**
 * Wait until the before-snapshot for a change is fully on disk.
 *
 * 5.x:capture 时异步建 before 快照(fire-and-forget)。SnapshotService 先写
 * marker、后写 blob(避免 GC 误删窗口) —— 只等 marker 会让回滚读到空 blob。
 * 注意:每个 ChangeService 实例的 id 都从 change-1 重新计数,必须用
 * sessionId + changeId 精确定位,否则会误匹配其他测试的残留 marker。
 * @module dsh-change-center/tests
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** SnapshotService 的目录安全化:替换路径分隔符。 */
function safe(part: string): string {
  return part.replace(/[\\/]/g, '_')
}

/** Poll until `changes/<safeSession>/<changeId>/{blob,absent}` 及其 blob 就绪。 */
export async function waitForSnapshot(sessionId: string, changeId: string, timeoutMs = 5000): Promise<void> {
  const home = process.env.DSH_HOME ?? ''
  const dir = join(home, 'change-center', 'snapshots', 'changes', safe(sessionId), changeId)
  const blobsRoot = join(home, 'change-center', 'snapshots', 'blobs')
  const start = Date.now()
  let ready = false
  while (!ready) {
    const marker = join(dir, 'blob')
    if (existsSync(marker)) {
      try {
        const hash = readFileSync(marker, 'utf8').trim()
        ready = existsSync(join(blobsRoot, hash))
      } catch {
        ready = false
      }
    } else {
      ready = existsSync(join(dir, 'absent'))
    }
    if (ready) break
    if (Date.now() - start > timeoutMs) throw new Error(`waitForSnapshot timed out for ${sessionId}/${changeId}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

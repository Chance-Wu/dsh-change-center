/**
 * Test teardown helper: remove a temp dir that async (fire-and-forget)
 * persistence may still be writing to. `rmSync` races those writes and
 * intermittently fails with ENOTEMPTY under full-suite parallel load; retry
 * briefly before giving up.
 * @module dsh-change-center/tests
 */

import { rmSync } from 'node:fs'

/** Remove a directory tree, retrying on ENOTEMPTY for up to ~500ms. */
export async function removeDirSafe(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

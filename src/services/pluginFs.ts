/**
 * Per-call sandbox policy for the plugin's OWN state writes under $DSH_HOME
 * (change/session stores, snapshots, history, policies).
 *
 * Plugin-owned data is not part of the session's file-effect boundary, so
 * these writes bypass the session sandbox: the bare local backend ignores
 * this argument, the host's sandboxed backend (`dsh-fs-sandbox`) honors it.
 * Without it, a default `dsh web` boot (workspace-write mode) fences
 * `$DSH_HOME` out of `writableRoots` — persistence silently dies and every
 * file apply fails at its snapshot write.
 * @module dsh-change-center/services
 */

export const PLUGIN_STATE_POLICY = {
  mode: 'danger-full-access',
  // Unused under danger-full-access, but the policy type requires the root.
  workspaceRoot: process.cwd(),
} as const

/**
 * Policy for the plugin's reviewed write-back INTO a session's workspace
 * (apply and rollback-restore). The write target lives under `change.cwd`,
 * so the fence must be rooted there — an agentless call would otherwise fall
 * back to the process cwd and deny the write in a default `dsh web` boot.
 */
export function workspaceWritePolicy(cwd: string) {
  return {
    mode: 'workspace-write',
    workspaceRoot: cwd.length > 0 ? cwd : process.cwd(),
  } as const
}

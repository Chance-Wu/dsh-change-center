/**
 * File-change domain model for the change center.
 *
 * A {@link FileChange} records one file mutation captured from a Harness
 * file tool (`write`/`edit`): the canonical before/after text, the diff
 * derived from them, and a review state-machine status.
 * @module dsh-change-center/models
 */

/** How a captured tool mutated the target. */
export type ChangeOperation =
  | 'create'
  | 'modify'
  | 'delete'
  | 'rename'
  /** Command/external changes record an executed action. */
  | 'execute'

/** Review state-machine status of one change. */
export type ChangeStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'failed'
  | 'rolled_back'

/** Who initiated the change. */
export type ChangeSource = 'agent' | 'user' | 'plugin'

/**
 * Change kind for the unified change model (phase 4): file changes come from
 * write/edit tools; command changes record a shell command the agent ran;
 * external changes record an out-of-band action (MCP, future tools). Command
 * and external changes reuse the same record shape: `path` holds the command
 * or target description, `before` is null, and `after` holds the command text
 * or action description.
 */
export type ChangeKind = 'file' | 'command' | 'external'

/** One captured file change. */
export interface FileChange {
  id: string
  /** Owning agent session id (exec.agent.session.id). */
  sessionId: string
  /** Display path reported by the tool. */
  path: string
  /** Session working directory the path was resolved against (for apply). */
  cwd: string
  /** Unified change kind; 'file' for write/edit captures. */
  kind: ChangeKind
  operation: ChangeOperation
  /** Full pre-mutation text (LF-normalized), or null for a create. */
  before: string | null
  /** Full post-mutation text (LF-normalized), or null for a delete. */
  after: string | null
  /** Unified-diff text derived from before/after. */
  diff: string
  status: ChangeStatus
  source: ChangeSource
  /** The tool invocation that produced the change. */
  toolName: string
  toolCallId?: string
  createdAt: number
  updatedAt: number
}

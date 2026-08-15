/**
 * Change-session domain model: groups the {@link FileChange} records one
 * agent turn produced, so review surfaces can accept or reject a whole
 * batch at once.
 * @module dsh-change-center/models
 */

/** Lifecycle status of a change session. */
export type ChangeSessionStatus =
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** Aggregated statistics over a session's changes. */
export interface ChangeStatistics {
  /** Number of distinct files touched. */
  files: number
  /** Total inserted lines across all diffs. */
  additions: number
  /** Total deleted lines across all diffs. */
  deletions: number
}

/** One grouping of captured file changes. */
export interface ChangeSession {
  id: string
  /** Display name (e.g. the turn number). */
  name: string
  status: ChangeSessionStatus
  /** Owning agent session id (exec.agent.session.id). */
  agentSessionId: string
  /** The session working directory changes were resolved against. */
  workspace: string
  /** Ids of the {@link FileChange} records in this session. */
  changeIds: string[]
  statistics: ChangeStatistics
  /** Git context when the workspace is a repository. */
  git?: {
    branch: string
    baseCommit: string
  }
  /** Vibe UI 2.3 S-8:自然语言摘要(如「修改 src/auth 下 3 个文件」),随会话落库。 */
  summary?: string
  createdAt: number
  updatedAt: number
}

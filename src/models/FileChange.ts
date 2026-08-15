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

/**
 * Review state-machine status of one change (应用↔回滚双操作模型):
 * pending(待处理)→ applied(已应用)→ rolled_back(已回滚)→ 可再 applied。
 * failed 覆盖应用失败(可重试)。approved/rejected 已随「接受/拒绝」流程移除。
 */
export type ChangeStatus =
  | 'pending'
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
  /**
   * 3.x:本插件最后一次确认的磁盘内容(null = 文件不存在)。捕获时 = after
   * (工具已写完),apply 成功后 = after,rollback 后 = before。编辑器修改
   * 不改变它 —— 因此「用户编辑 → Apply」不会误判为外部修改,而外部改动
   * 仍会被 hash 守卫拦截。旧记录缺省时回退为与 after 比较。
   */
  diskBaseline?: string | null
  /**
   * Qoder 风格块级操作:diff 各 hunk 的应用状态(与 `diffHunks` 顺序一一对应)。
   * 缺省 = 全部已应用(捕获发生在写盘之后,文件已是 after);`false` 表示该块
   * 已撤销(文件该区域保持 before 内容)。
   */
  hunkApplied?: boolean[]
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

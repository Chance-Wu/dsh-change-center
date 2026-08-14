/**
 * Captures file mutations and command executions from the Harness tool
 * pipeline.
 *
 * Every tool call (native, MCP, shell, code-mode sub-dispatch) traverses the
 * `ctx.tools` execution pipeline; `tools/result` fires once per finished call
 * with the frozen execution and its result.
 *
 * - `write`/`edit` become **file** changes (kind='file'), using the
 *   canonical result that already carries full before/after text.
 * - `bash` becomes a **command** change (kind='command'), recording the
 *   command text only — never re-running it. Command captures are recorded
 *   as pending and governed by policy like any other change.
 *
 * @module dsh-change-center/capture
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ChangeOperation } from '../models/FileChange.ts'

/** The first-party file tools whose result carries full before/after text. */
const FILE_TOOLS = new Set(['write', 'edit'])

/** Command tools whose argument carries the executed command text. */
const COMMAND_TOOLS = new Set(['bash'])

/**
 * Tool-capture plugin body: subscribe to `tools/result` and forward
 * write/edit outcomes and bash commands into the change store.
 * @param ctx - host context providing the change service.
 */
export function applyCapture(ctx: Context): void {
  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    // Non-agent callers have no owning session to attribute the change to.
    if (exec.agent === undefined) return
    if (result.isError) return
    const sessionId = exec.agent.session.id
    const cwd = exec.agent.session.header.cwd ?? ''
    // Resolve the store through the service seam: the plugin's entry context
    // (loader-assigned) has no inject declaration for `changeCenter`, so a
    // direct property read trips the cordis "without inject" guard inside the
    // tool observer. `ctx.get()` performs an explicit service lookup instead.
    const changeCenter = ctx.get('changeCenter')
    if (changeCenter === undefined) return

    if (FILE_TOOLS.has(exec.name)) {
      const captured = extractFileChange(exec, result)
      if (captured === undefined) return
      changeCenter.record({
        sessionId,
        cwd,
        kind: 'file',
        path: captured.path,
        operation: captured.operation,
        before: captured.before,
        after: captured.after,
        source: 'agent',
        toolName: exec.name,
        toolCallId: exec.callId,
      })
      return
    }

    if (COMMAND_TOOLS.has(exec.name)) {
      const command = extractCommand(exec)
      if (command === undefined || command.length === 0) return
      changeCenter.record({
        sessionId,
        cwd,
        kind: 'command',
        path: command,
        operation: 'execute',
        before: null,
        after: command,
        source: 'agent',
        toolName: exec.name,
        toolCallId: exec.callId,
      })
    }
  })
}

interface CapturedFileChange {
  path: string
  operation: ChangeOperation
  before: string | null
  after: string | null
}

/**
 * Pull the canonical before/after payload out of a write/edit success result.
 * The tools return `{ path, operation?, before, after }` (write reports
 * `operation: 'create' | 'update'`; edit omits it — it only modifies).
 */
function extractFileChange(exec: ToolExecution, result: ToolExecutionResult): CapturedFileChange | undefined {
  const value = result.isError ? undefined : (result as { value: unknown }).value
  if (!isRecord(value)) return undefined
  const path = typeof value.path === 'string' ? value.path : undefined
  if (path === undefined || path.length === 0) return undefined
  const operation: ChangeOperation = value.operation === 'create'
    ? 'create'
    : value.operation === 'delete'
      ? 'delete'
      : 'modify'
  return {
    path,
    operation,
    before: typeof value.before === 'string' ? value.before : null,
    after: typeof value.after === 'string' ? value.after : null,
  }
}

/** The command string from a bash tool execution. */
function extractCommand(exec: ToolExecution): string | undefined {
  if (!isRecord(exec.arguments)) return undefined
  const command = exec.arguments.command
  return typeof command === 'string' ? command : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * AI auto-fix: given one review finding, ask the model to produce the FIXED
 * FULL FILE CONTENT, then record it as a new pending change via the change
 * store's `edit()` — never writing to disk directly. The new change goes
 * through the normal review/apply pipeline.
 *
 * Provider/model come from `agentDefaultModel.currentSelection()` (provider
 * agnostic), the same as AI review.
 * @module dsh-change-center/fix
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls `ctx.llm` and `ctx.agentDefaultModel` into scope.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FixRequest, FixResult } from '../models/Phase4.ts'
import type { ReviewFinding } from '../models/Phase3.ts'
import type { ActionError, ChangeService } from '../services/ChangeService.ts'
import type { FileChange } from '../models/FileChange.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    aiFix: AIFixService
  }
}

const FIX_MAX_TOKENS = 4000

/** System prompt: produce the full fixed file, nothing else. */
const FIX_SYSTEM = 'You are a code-fixing assistant. Given a file and a review finding, produce the COMPLETE fixed file content. Respond with ONLY the file content inside a single markdown code fence — no explanations, no diff, no surrounding text.'

/** Runs one AI fix request against a review finding. */
export class AIFixService extends Service {
  private readonly requests = new Map<string, FixRequest>()
  private nextId = 1

  constructor(ctx: Context) {
    super(ctx, 'aiFix')
  }

  /** All fix requests for a session, newest first. */
  list(sessionId: string): FixRequest[] {
    return [...this.requests.values()]
      .filter(request => request.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): FixRequest | undefined {
    return this.requests.get(id)
  }

  /**
   * Fix one finding: ask the model for the fixed full file, then update the
   * change via `edit()` (new pending change).
   * @param reviewId - the review that produced the finding.
   * @param finding - the finding to fix.
   * @param change - the file change to fix (kind must be 'file').
   * @param changes - the change store.
   * @param opts - optional cancellation signal (honored by the LLM stream).
   * @returns the fix result with the produced change id.
   */
  async fix(reviewId: string, finding: ReviewFinding, change: FileChange, changes: ChangeService, opts?: { signal?: AbortSignal }): Promise<FixResult> {
    const request: FixRequest = {
      id: `fix-${this.nextId++}`,
      reviewId,
      findingId: finding.id,
      sessionId: change.sessionId,
      changeId: change.id,
      status: 'running',
      instruction: finding.title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.requests.set(request.id, request)

    if (change.kind !== 'file' || change.after === null) {
      request.status = 'failed'
      request.resultSummary = 'AI fix requires a file change with after content'
      request.updatedAt = Date.now()
      return { fixRequestId: request.id, changeIds: [], summary: request.resultSummary }
    }

    const prompt = [
      `File: ${change.path}`,
      '',
      'Current content:',
      '```',
      change.after,
      '```',
      '',
      `Review finding (${finding.severity}): ${finding.title}`,
      finding.description,
      finding.suggestion !== undefined ? `Suggestion: ${finding.suggestion}` : '',
      '',
      'Produce the COMPLETE fixed file content in one code fence.',
    ].join('\n')

    const selection = this.ctx.get('agentDefaultModel')?.currentSelection()
    if (selection === undefined) {
      request.status = 'failed'
      request.resultSummary = 'no default model configured'
      request.updatedAt = Date.now()
      return { fixRequestId: request.id, changeIds: [], summary: request.resultSummary }
    }
    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      request.status = 'failed'
      request.resultSummary = 'llm service unavailable'
      request.updatedAt = Date.now()
      return { fixRequestId: request.id, changeIds: [], summary: request.resultSummary }
    }
    const assembler = new BlockAssembler()
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dsh-change-center' },
      }),
    ]
    try {
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {},
        system: FIX_SYSTEM,
        messages,
        maxTokens: FIX_MAX_TOKENS,
        ...opts?.signal !== undefined ? { signal: opts.signal } : {},
      })) {
        assembler.push(chunk)
      }
      const text = assembler.blocks()
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('')
      const fixed = extractFencedContent(text)
      if (fixed === undefined) {
        request.status = 'failed'
        request.resultSummary = 'Model did not return fenced file content'
        request.updatedAt = Date.now()
        return { fixRequestId: request.id, changeIds: [], summary: request.resultSummary }
      }
      // Record the fix as a new pending change (never write to disk here).
      const updated = changes.edit(change.id, fixed)
      if (isEditError(updated)) {
        request.status = 'failed'
        request.resultSummary = updated.message
        request.updatedAt = Date.now()
        return { fixRequestId: request.id, changeIds: [], summary: request.resultSummary }
      }
      request.status = 'completed'
      request.resultSummary = `Fixed ${change.path} (${change.id} reset to pending)`
      request.updatedAt = Date.now()
      return {
        fixRequestId: request.id,
        changeIds: [updated.id],
        summary: request.resultSummary,
      }
    } catch (error) {
      request.status = 'failed'
      request.resultSummary = error instanceof Error ? error.message : String(error)
      request.updatedAt = Date.now()
      return { fixRequestId: request.id, changeIds: [], summary: request.resultSummary }
    }
  }
}

/** Extract the content of the first markdown code fence. */
export function extractFencedContent(text: string): string | undefined {
  const match = text.trim().match(/```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)\n```/)
  if (match !== null) return match[1]
  // Fallback: the whole text if it is not empty and looks like file content.
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Narrow an edit result to its error variant (edit 结构化错误,不抛). */
function isEditError(result: FileChange | ActionError): result is ActionError {
  return typeof result === 'object' && result !== null && (result as ActionError).kind === 'error'
}

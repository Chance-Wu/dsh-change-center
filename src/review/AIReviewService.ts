/**
 * AI code review: feeds a session's diffs to the model (through `ctx.llm`)
 * and parses the structured JSON response.
 *
 * The provider/model come from `agentDefaultModel.currentSelection()` — the
 * same selection agents run under — so the review is provider-agnostic and
 * never hard-codes a vendor. The model is asked to review only (findings and
 * risk), never to edit code.
 * @module dsh-change-center/review
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls `ctx.llm`, `ctx.agentDefaultModel`, and message helpers.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ReviewFinding, ReviewResult, RiskLevel } from '../models/Phase3.ts'
import type { SessionService } from '../services/SessionService.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    aiReview: AIReviewService
  }
}

const REVIEW_MAX_TOKENS = 2000

/** System prompt: the model reviews, never edits. */
const REVIEW_SYSTEM = 'You are a senior code reviewer. Analyze the given file changes and report risks and issues. Never propose editing the code yourself — only review. Respond with STRICT JSON only, no markdown fences.'

/** One finding parsed from the model's JSON. */
interface RawFinding {
  severity?: string
  file?: string
  filePath?: string
  line?: number
  title?: string
  description?: string
  suggestion?: string
}

/** Runs a structured AI review over one change session. */
export class AIReviewService extends Service {
  private readonly results = new Map<string, ReviewResult>()
  private nextFindingId = 1

  constructor(ctx: Context) {
    super(ctx, 'aiReview')
  }

  /** The stored review for a session, if one exists. */
  get(sessionId: string): ReviewResult | undefined {
    return this.results.get(sessionId)
  }

  /**
   * Review a session's changes with the model.
   * @param sessionId - the change session id.
   * @param sessions - the session service (to read the session's changes).
   * @param workspace - workspace path, for context.
   * @param opts - optional cancellation signal (honored by the LLM stream).
   */
  async review(sessionId: string, sessions: SessionService, workspace: string, opts?: { signal?: AbortSignal }): Promise<ReviewResult> {
    const changes = sessions.changesOf(sessionId)
    const diffText = changes.length === 0
      ? '(no changes captured)'
      : changes.map(change => `--- ${change.path} (${change.operation})\n${change.diff}`).join('\n\n')
    const prompt = [
      `Workspace: ${workspace}`,
      `Session: ${sessionId}`,
      '',
      'Changes to review:',
      diffText,
      '',
      'Respond with STRICT JSON: {"risk":"low|medium|high|critical","score":0..100,"summary":"...","findings":[{"severity":"info|warning|error|critical","file":"...","line":N,"title":"...","description":"...","suggestion":"..."}]}',
    ].join('\n')

    const selection = this.ctx.get('agentDefaultModel')?.currentSelection()
    if (selection === undefined) {
      throw new Error('ai-review: no default model configured')
    }
    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      throw new Error('ai-review: llm service unavailable')
    }
    const assembler = new BlockAssembler()
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dsh-change-center' },
      }),
    ]
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {},
      system: REVIEW_SYSTEM,
      messages,
      maxTokens: REVIEW_MAX_TOKENS,
      ...opts?.signal !== undefined ? { signal: opts.signal } : {},
    })) {
      assembler.push(chunk)
    }

    const text = assembler.blocks()
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('')
    const parsed = parseReviewJson(text, sessionId, () => `finding-${this.nextFindingId++}`)
    this.results.set(sessionId, parsed)
    this.ctx.emit('change:reviewed', parsed)
    return parsed
  }
}

/**
 * Tolerant parse of the model's JSON: strips markdown fences, tolerates a
 * trailing prose paragraph, and falls back to a review with an error finding
 * when the payload is not JSON at all.
 */
export function parseReviewJson(text: string, sessionId: string, mintId: () => string): ReviewResult {
  const cleaned = stripFences(text)
  const jsonStart = cleaned.indexOf('{')
  if (jsonStart < 0) {
    return {
      sessionId,
      summary: 'Model did not return a JSON review.',
      risk: 'medium',
      score: 50,
      findings: [errorFinding(mintId(), 'Review parse failure', 'The reviewer output was not structured JSON.', text.slice(0, 500))],
    }
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(cleaned.slice(jsonStart)) as Record<string, unknown>
  } catch {
    return {
      sessionId,
      summary: 'Model returned unparseable JSON.',
      risk: 'medium',
      score: 50,
      findings: [errorFinding(mintId(), 'Review parse failure', 'The reviewer JSON could not be parsed.', cleaned.slice(0, 500))],
    }
  }
  const findings: ReviewFinding[] = (Array.isArray(raw.findings) ? raw.findings : [])
    .filter((f): f is RawFinding => typeof f === 'object' && f !== null)
    .map(f => ({
      id: mintId(),
      severity: normalizeSeverity(f.severity),
      filePath: f.file ?? f.filePath ?? '',
      ...f.line !== undefined ? { line: f.line } : {},
      title: f.title ?? 'Finding',
      description: f.description ?? '',
      ...f.suggestion !== undefined ? { suggestion: f.suggestion } : {},
    }))
  return {
    sessionId,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    risk: normalizeRisk(raw.risk),
    score: clampScore(raw.score),
    findings,
  }
}

/** Strip a markdown code fence wrapper if present. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenced !== null ? fenced[1]! : trimmed
}

function normalizeSeverity(value: unknown): ReviewFinding['severity'] {
  if (value === 'critical' || value === 'error' || value === 'warning' || value === 'info') return value
  return 'info'
}

function normalizeRisk(value: unknown): RiskLevel {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') return value
  return 'medium'
}

function clampScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50
  return Math.max(0, Math.min(100, Math.round(value)))
}

function errorFinding(id: string, title: string, description: string, detail: string): ReviewFinding {
  return {
    id,
    severity: 'error',
    filePath: '',
    title,
    description: `${description}\n${detail}`,
  }
}

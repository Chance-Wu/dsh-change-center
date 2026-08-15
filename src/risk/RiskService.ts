/**
 * Risk engine: deterministic rules over a session's changes, optionally
 * overridden by the AI review's risk level.
 *
 * Rules are explicit and testable (no model dependence); the AI review
 * result, when present, participates via `max(ruleLevel, aiLevel)`.
 * @module dsh-change-center/risk
 */

import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ChangeRisk, RiskLevel, RiskReason } from '../models/Phase3.ts'
import type { ChangeService } from '../services/ChangeService.ts'
import type { AIReviewService } from '../review/AIReviewService.ts'
import { PLUGIN_STATE_POLICY } from '../services/pluginFs.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    risk: RiskService
  }
}

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/** Deterministic risk rules: path/deletion heuristics. */
const HIGH_DELETION_LINES = 500
const HIGH_PATH_PATTERNS = [
  /securityconfig/i,
  /permission/i,
  /authorization/i,
  /role/i,
  /\.sql$/i,
]
const MEDIUM_PATH_PATTERNS = [
  /pom\.xml$/,
  /package\.json$/,
  /build\.gradle(\.kts)?$/,
  /application\.ya?ml$/,
  /application\.properties$/,
]

/** Aggregated risk per change session. */
export class RiskService extends Service {
  static inject = ['changeCenter', 'changeSessions']

  private readonly risks = new Map<string, ChangeRisk>()
  private loadPromise: Promise<void> | undefined
  private readonly root: string

  constructor(ctx: Context) {
    super(ctx, 'risk')
    this.root = join(resolveDshHome(), 'change-center', 'risk')
    // 冷启动:把持久化的风险结果读回内存(失败静默)。
    this.ensureLoaded()
  }

  /** Load persisted risks once; safe to call repeatedly. */
  ensureLoaded(): Promise<void> {
    if (this.loadPromise === undefined) {
      this.loadPromise = this.loadFromDisk().catch(() => undefined)
    }
    return this.loadPromise
  }

  private async loadFromDisk(): Promise<void> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    const rootTarget = await fs.resolve(this.root)
    const entries = await fs.listDir(rootTarget)
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await fs.readText(entry.target)) as ChangeRisk
        if (typeof parsed.level !== 'string') continue
        // 文件名即 session id(safe 转义);RiskChange 自身不携带 sessionId。
        this.risks.set(entry.name.replace(/\.json$/, ''), parsed)
      } catch {
        // Skip corrupt risk files.
      }
    }
  }

  /** The stored risk for a session, if one exists. */
  get(sessionId: string): ChangeRisk | undefined {
    return this.risks.get(sessionId)
  }

  /**
   * Compute the risk for a session's changes.
   * @param sessionId - the change session id.
   * @param changes - the change service (to read the session's changes).
   * @param review - optional AI review result to fold in.
   */
  analyze(sessionId: string, changes: ChangeService, review?: ReturnType<AIReviewService['get']>): ChangeRisk {
    // The change store is keyed by the AGENT session id (change.sessionId),
    // while this record is keyed by the change-session id — resolve the
    // mapping (like the history route) so the rules see the session's
    // changes. Headless callers passing the agent key directly fall through.
    const sessions = this.ctx.get('changeSessions')
    const agentKey = sessions?.get(sessionId)?.agentSessionId ?? sessionId
    const sessionChanges = changes.listBySession(agentKey)
    const reasons: RiskReason[] = []
    let level: RiskLevel = 'low'
    let score = 100

    const raise = (candidate: RiskLevel, reason: RiskReason): void => {
      reasons.push(reason)
      if (LEVEL_ORDER[candidate] > LEVEL_ORDER[level]) level = candidate
      score = Math.min(score, 100 - LEVEL_ORDER[candidate] * 20)
    }

    for (const change of sessionChanges) {
      // Deleted file.
      if (change.operation === 'delete') {
        raise('high', { rule: 'delete-file', level: 'high', detail: `${change.path} is deleted` })
      }
      // Large deletion (hunk line count from the diff).
      const deletions = countDeletions(change.diff)
      if (deletions > HIGH_DELETION_LINES) {
        raise('high', { rule: 'large-deletion', level: 'high', detail: `${change.path} deletes ${deletions} lines` })
      }
      // Sensitive path patterns.
      if (HIGH_PATH_PATTERNS.some(pattern => pattern.test(change.path))) {
        raise('high', { rule: 'sensitive-path', level: 'high', detail: `${change.path} matches a sensitive pattern` })
      } else if (MEDIUM_PATH_PATTERNS.some(pattern => pattern.test(change.path))) {
        raise('medium', { rule: 'config-path', level: 'medium', detail: `${change.path} is a configuration/dependency file` })
      }
    }

    // Fold in the AI review level: max(rule, ai).
    if (review !== undefined) {
      raise(review.risk, {
        rule: 'ai-review',
        level: review.risk,
        detail: review.summary || 'AI review risk',
      })
    }

    const result: ChangeRisk = { level, score: Math.max(0, score), reasons }
    this.risks.set(sessionId, result)
    this.persist(sessionId, result)
    return result
  }

  /** Best-effort write of one risk result to $DSH_HOME/change-center/risk/. */
  private persist(sessionId: string, result: ChangeRisk): void {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    void (async () => {
      try {
        const target = await fs.resolve(join(this.root, sessionId.replace(/[/\\]/g, '_') + '.json'))
        // 插件自有状态:$DSH_HOME 不在会话沙箱 writableRoots 内,显式放行。
        await fs.writeText(target, JSON.stringify(result), undefined, undefined, PLUGIN_STATE_POLICY)
      } catch {
        // Best-effort persistence: the in-memory result remains authoritative.
      }
    })()
  }
}

/** Count `-` prefixed (deletion) lines in a unified diff. */
export function countDeletions(diff: string): number {
  let count = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('-') && !line.startsWith('--')) count++
  }
  return count
}

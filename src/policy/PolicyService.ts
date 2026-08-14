/**
 * Policy engine: evaluates a change session against ordered, condition-based
 * policies and decides whether changes may proceed (allow), need warning
 * (warn), or are denied.
 *
 * Policies are declarative ({@link ChangePolicy}); the built-in set ships
 * enabled, and user overrides persist under
 * `$DSH_HOME/change-center/policies.json`. Evaluation walks policies by
 * priority and returns the first match per change.
 * @module dsh-change-center/policy
 */

import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.fs` Context merge into scope.
import type {} from '@deepseek-ai/dsh-fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ChangePolicy, PolicyEvaluation } from '../models/Phase4.ts'
import type { ChangeRisk, RiskLevel } from '../models/Phase3.ts'
import type { FileChange } from '../models/FileChange.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    policies: PolicyService
  }
}

/** Built-in policies (documented phase-4 batch one). */
const BUILTIN_POLICIES: ChangePolicy[] = [
  {
    id: 'deny-core-delete',
    name: 'Deny core file deletion',
    enabled: true,
    priority: 100,
    conditions: [
      { type: 'operation', operator: 'equals', value: 'delete' },
      { type: 'file', operator: 'matches', value: '^src/(security|config)/' },
    ],
    action: 'deny',
  },
]

/** Ordered evaluation of change policies. */
export class PolicyService extends Service {
  static inject = ['fs']

  private readonly root: string
  private policies: ChangePolicy[] | undefined

  constructor(ctx: Context) {
    super(ctx, 'policies')
    this.root = join(resolveDshHome(), 'change-center', 'policies.json')
  }

  /** All policies (built-in merged with persisted user overrides), by priority. */
  async list(): Promise<ChangePolicy[]> {
    if (this.policies !== undefined) return this.policies
    const persisted = await this.loadPersisted()
    const merged = BUILTIN_POLICIES.map(builtin => {
      const override = persisted?.find(p => p.id === builtin.id)
      return override !== undefined ? { ...builtin, ...override } : builtin
    })
    // Any user-added policies beyond built-ins.
    for (const p of persisted ?? []) {
      if (!merged.some(existing => existing.id === p.id)) merged.push(p)
    }
    this.policies = merged.sort((a, b) => b.priority - a.priority)
    return this.policies
  }

  /** Replace one policy (by id), persisting the result. */
  async save(policy: ChangePolicy): Promise<ChangePolicy[]> {
    const current = await this.list()
    const index = current.findIndex(p => p.id === policy.id)
    if (index >= 0) current[index] = policy
    else current.push(policy)
    this.policies = current.sort((a, b) => b.priority - a.priority)
    await this.persist(current)
    return this.policies
  }

  /** Delete a user-added policy by id. */
  async delete(id: string): Promise<ChangePolicy[]> {
    const current = await this.list()
    const next = current.filter(p => p.id !== id)
    this.policies = next
    await this.persist(next)
    return this.policies
  }

  /**
   * Evaluate a session's changes against all enabled policies.
   * @param changes - the session's changes.
   * @param risk - the session's risk result, if computed.
   * @returns the first matching evaluation per distinct policy (ordered by
   *   priority); the strongest action (deny > warn > allow) can be derived
   *   by callers.
   */
  async evaluate(changes: FileChange[], risk?: ChangeRisk): Promise<PolicyEvaluation[]> {
    const policies = await this.list()
    const evaluations: PolicyEvaluation[] = []
    const levelOrder: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 }
    const sessionRisk: RiskLevel = risk?.level ?? 'low'
    for (const policy of policies) {
      if (!policy.enabled) continue
      for (const change of changes) {
        const reason = matchPolicy(policy, change, sessionRisk, levelOrder)
        if (reason !== undefined) {
          evaluations.push({ policyId: policy.id, action: policy.action, reason })
          break // one evaluation per policy per session
        }
      }
    }
    return evaluations
  }

  private async loadPersisted(): Promise<ChangePolicy[] | undefined> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return undefined
    try {
      const target = await fs.resolve(this.root)
      if (await fs.stat(target) === undefined) return undefined
      const raw = await fs.readText(target)
      const parsed = JSON.parse(raw) as ChangePolicy[]
      return Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  private async persist(policies: ChangePolicy[]): Promise<void> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    try {
      const target = await fs.resolve(this.root)
      await fs.writeText(target, JSON.stringify(policies, null, 2))
    } catch {
      // Best-effort persistence.
    }
  }
}

/** Match one policy against one change; returns a reason or undefined. */
function matchPolicy(
  policy: ChangePolicy,
  change: FileChange,
  sessionRisk: RiskLevel,
  levelOrder: Record<RiskLevel, number>,
): string | undefined {
  let reason: string | undefined
  for (const condition of policy.conditions) {
    const matched = matchCondition(condition, change, sessionRisk, levelOrder)
    if (!matched) return undefined
    reason = describeCondition(condition, change)
  }
  return reason
}

function matchCondition(
  condition: { type: string; operator: string; value: unknown },
  change: FileChange,
  sessionRisk: RiskLevel,
  levelOrder: Record<RiskLevel, number>,
): boolean {
  switch (condition.type) {
    case 'file':
      return compareString(change.path, condition.operator, String(condition.value))
    case 'operation':
      return compareString(change.operation, condition.operator, String(condition.value))
    case 'risk': {
      const level = levelOrder[sessionRisk] ?? 0
      const threshold = levelOrder[String(condition.value) as RiskLevel] ?? 0
      return condition.operator === 'greater_than' ? level > threshold : level === threshold
    }
    case 'command':
      return compareString(change.after ?? '', condition.operator, String(condition.value))
    case 'language':
      return compareString(change.path, condition.operator, String(condition.value))
    default:
      return false
  }
}

function compareString(actual: string, operator: string, expected: string): boolean {
  switch (operator) {
    case 'equals': return actual === expected
    case 'contains': return actual.includes(expected)
    case 'matches': {
      try { return new RegExp(expected).test(actual) } catch { return false }
    }
    default: return false
  }
}

function describeCondition(condition: { type: string; value: unknown }, change: FileChange): string {
  return `${condition.type} ${String(condition.value)} matched for ${change.path}`
}

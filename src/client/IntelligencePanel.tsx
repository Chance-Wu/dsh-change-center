/**
 * Intelligence panel: the phase-3 right column — git facts, AI review,
 * risk, verification, policy, and timeline, stacked as collapsible cards.
 *
 * Vibe UI: this column lives inside the 「··· / 更多」 fold of the review
 * panel (V-1), risk shows level signals without numeric scores (V-5), AI
 * review is on-demand (V-6), and job-backed actions present as
 * 运行中…/✓ 完成/! 失败 [重试] — never as Job IDs (V-9). Finding rows are
 * clickable and locate the matching change in the tree/diff (S-7 groundwork).
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ChangeCenterApi, GitResponse, JobHandle, WireAnalytics, WireChange, WireHistoryEvent, WireReview, WireRisk, WireVerificationTask } from './index.ts'
import { PolicyPanel } from './PolicyPanel.tsx'
import { TimelineView } from './TimelineView.tsx'
import { LOOP_STOPPED_ZH, RISK_ZH, SEVERITY_ZH } from './i18n.ts'
import { RiskSignal, type SignalLevel } from './RiskSignal.tsx'
import { Chevron } from './icons.tsx'
import baseCss from './styles.module.css'
import css from './IntelligencePanel.module.css'

/** Props for the intelligence panel. */
export interface IntelligencePanelProps {
  sessionId: string
  workspace: string
  api: ChangeCenterApi
  onChanged: () => void
  /** The reviewable (deduped) changes, for finding → change locating. */
  changes?: WireChange[]
  /** Called when a finding row is clicked: locate the change in the surface. */
  onLocate?: (changeId: string) => void
  /** 4.1:会话事件序列(面板已取;缺省时本组件自行拉取)。 */
  timeline?: WireHistoryEvent[]
}

/** Right-column intelligence cards. */
export function IntelligencePanel(props: IntelligencePanelProps): ReactElement {
  const { sessionId, workspace, api, onChanged, changes = [], onLocate, timeline: timelineProp } = props
  const [git, setGit] = useState<GitResponse | null>(null)
  const [review, setReview] = useState<WireReview | null>(null)
  const [risk, setRisk] = useState<WireRisk | null>(null)
  const [verification, setVerification] = useState<WireVerificationTask[]>([])
  const [timeline, setTimeline] = useState<WireHistoryEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [jobRunning, setJobRunning] = useState(false)
  const cancelRef = useRef<(() => Promise<void>) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loopMessage, setLoopMessage] = useState<string | null>(null)
  /** Last failed action, for the [重试] button (V-9: jobs are not user concepts). */
  const retryRef = useRef<(() => void) | null>(null)

  const refresh = (): void => {
    api.gitStatus(sessionId).then(setGit).catch(() => setGit(null))
    api.reviewGet(sessionId).then(setReview).catch(() => setReview(null))
    api.riskGet(sessionId).then(setRisk).catch(() => setRisk(null))
    api.verificationList(sessionId).then(setVerification).catch(() => setVerification([]))
    api.timeline(sessionId)
      .then(body => setTimeline(body.events))
      .catch(() => setTimeline([]))
  }

  useEffect(() => {
    refresh()
  }, [sessionId])

  /**
   * Run one action. Job-backed actions (verification/review/fix/loop) yield a
   * {@link JobHandle}: the panel holds its cancel and shows a 取消 button while
   * it runs; cancellation settles the job to `cancelled`, which is not an
   * error. Plain actions (risk analyze) run as before.
   */
  const run = (action: () => Promise<unknown>, onDone?: (result: unknown) => void): void => {
    setBusy(true)
    setError(null)
    retryRef.current = () => run(action, onDone)
    void (async () => {
      try {
        const result = await action()
        const handle = result as JobHandle<unknown> | undefined
        if (handle !== undefined && typeof handle.jobId === 'string') {
          cancelRef.current = handle.cancel
          setJobRunning(true)
          onDone?.(await handle.done)
        } else {
          onDone?.(undefined)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('cancelled')) setError(msg)
      } finally {
        refresh()
        onChanged()
        setBusy(false)
        setJobRunning(false)
        cancelRef.current = null
      }
    })()
  }

  const cancelCurrent = (): void => {
    void cancelRef.current?.().catch(() => undefined)
  }

  const runLoop = (): void => {
    setLoopMessage(null)
    run(() => api.loopRun(sessionId), result => {
      const r = (result as { result: { iterations: number; stopped: string } } | undefined)
      if (r !== undefined) {
        setLoopMessage(`修复循环结束：${LOOP_STOPPED_ZH[r.result.stopped] ?? r.result.stopped}，共 ${r.result.iterations} 轮`)
      }
    })
  }

  return createElement('div', { className: css.panel },
    error !== null
      ? createElement('div', { className: css.panelError },
        createElement('span', null, error),
        createElement('button', { onClick: () => retryRef.current?.(), className: baseCss.buttonMini }, '重试'),
      )
      : null,
    // 分组收纳:核心组(智能分析/验证)默认展开,次要组折叠。
    createElement(Group, { title: '智能分析', defaultOpen: true },
      createElement(ReviewCard, {
        review, busy, onRun: () => run(() => api.reviewRun(sessionId)),
        onLocate: onLocate,
        changes,
        onFix: (findingId) => {
          // Fix the first file change matching the finding path.
          api.sessionChanges(sessionId, { limit: 500 }).then(page => {
            const change = page.items.find(c => c.kind === 'file' && findingPathMatches(c.path, review?.findings.find(f => f.id === findingId)?.filePath ?? ''))
            if (change === undefined) {
              setError('没有与这条发现匹配的文件变更')
              return
            }
            run(() => api.fixRun(sessionId, review?.sessionId ?? sessionId, findingId, change.id))
          }).catch(err => setError(err instanceof Error ? err.message : String(err)))
        },
      }),
      createElement(RiskCard, { risk, busy, onAnalyze: () => run(() => api.riskAnalyze(sessionId)) }),
    ),
    createElement(Group, { title: '验证', defaultOpen: true },
      createElement(VerificationCard, { tasks: verification, busy, onRun: () => run(() => api.verificationRun(sessionId)) }),
    ),
    createElement(Group, { title: '开发' },
      createElement(GitCard, { git, workspace }),
      createElement(PolicyPanel, { sessionId, api, onChanged }),
      createElement(TimelineCard, { events: timelineProp ?? timeline, changes }),
    ),
    // 4.7 Change Analytics:轻量统计(7 天窗口)。
    createElement(Group, { title: '统计' },
      createElement(AnalyticsCard, { api }),
    ),
    createElement(Group, { title: '修复' },
      createElement('div', { className: css.loopRow },
        createElement('button', { onClick: runLoop, disabled: busy, className: baseCss.buttonGhost }, busy ? '运行中…' : '运行修复循环'),
        jobRunning
          ? createElement('button', { onClick: cancelCurrent, className: baseCss.buttonDanger }, '取消')
          : null,
        loopMessage !== null ? createElement('span', { className: css.loopMessage }, loopMessage) : null,
      ),
    ),
  )
}

/** 分组折叠容器:核心组默认展开,点击标题切换;组本身无边框(内嵌卡片自带)。 */
function Group(props: { title: string; defaultOpen?: boolean; children?: ReactElement | ReactElement[] }): ReactElement {
  const [expanded, setExpanded] = useState(props.defaultOpen ?? false)
  return createElement('div', { className: css.group },
    createElement('button', {
      onClick: () => setExpanded(!expanded),
      className: css.groupTitle,
      'aria-expanded': expanded,
    },
    createElement(Chevron, { expanded }),
    createElement('span', null, props.title),
    ),
    expanded ? createElement('div', { className: css.groupBody }, props.children) : null,
  )
}

function card(title: string, children: ReactElement | ReactElement[] | string): ReactElement {
  return createElement('div', { className: baseCss.card },
    createElement('div', { className: baseCss.cardTitle }, title),
    createElement('div', { className: css.cardBody }, children),
  )
}

/** 4.7:轻量统计卡(7 天窗口)。 */
function AnalyticsCard(props: { api: ChangeCenterApi }): ReactElement {
  const { api } = props
  const [data, setData] = useState<WireAnalytics | null>(null)
  useEffect(() => {
    api.analytics().then(setData).catch(() => setData(null))
  }, [])
  return card('变更统计',
    data === null
      ? createElement('div', { className: baseCss.muted }, '暂无数据')
      : createElement('div', { className: css.smallText },
        createElement('div', null, '近 7 天 · Agent 修改 ', createElement('b', null, `${data.files}`), ' 个文件'),
        createElement('div', null, '成功应用 ', createElement('b', null, `${data.applied}`), ' 次 · 成功率 ', createElement('b', null, `${data.successRate}%`), ` · 回滚 ${data.rollbacks}`),
        data.topFiles.length > 0
          ? createElement('div', { className: css.cardBodyTight },
            createElement('div', { className: `${baseCss.muted} ${css.cardBodyTight}` }, '高频修改:'),
            data.topFiles.map(item => createElement('div', { key: item.path, className: css.gitEntry },
              createElement('span', { className: css.gitEntryPath }, item.path),
              createElement('span', { className: css.gitEntryCode }, `×${item.count}`),
            )),
          )
          : null,
      ),
  )
}

function GitCard(props: { git: GitResponse | null; workspace: string }): ReactElement {
  const { git, workspace } = props
  const repo = git?.repo
  const entries = git?.entries ?? []
  const notGit = repo !== undefined && 'error' in repo
  return card('代码库',
    notGit
      ? createElement('div', { className: baseCss.muted }, '不是 Git 仓库')
      : createElement('div', { className: css.smallText },
        createElement('div', null, '分支：', createElement('b', null, repo && 'branch' in repo ? repo.branch : '—')),
        createElement('div', null, '提交：', createElement('b', null, repo && 'head' in repo ? repo.head : '—')),
        createElement('div', null, repo && 'dirty' in repo ? (repo.dirty ? '● 有未提交修改' : '○ 干净') : ''),
        entries.length > 0
          ? createElement('div', { className: css.gitEntries },
            entries.slice(0, 8).map(entry => createElement('div', { key: `${entry.code} ${entry.path}`, className: css.gitEntry },
              createElement('span', { className: css.gitEntryCode }, gitCodeZh(entry.code)),
              createElement('span', { className: css.gitEntryPath }, entry.path),
            )),
            entries.length > 8
              ? createElement('div', { className: `${baseCss.muted} ${css.cardBodyTight}` }, `… 共 ${entries.length} 项`)
              : null,
          )
          : null,
        createElement('div', { className: `${baseCss.muted} ${css.cardBodyTight}` }, workspace),
      ),
  )
}

/** git porcelain status 码 → 中文短标签。 */
function gitCodeZh(code: string): string {
  const first = code.trim()[0] ?? ''
  switch (first) {
    case '?': return '未跟踪'
    case 'M': return '已修改'
    case 'A': return '已新增'
    case 'D': return '已删除'
    case 'R': return '已重命名'
    default: return first.length > 0 ? first : '已修改'
  }
}

function ReviewCard(props: {
  review: WireReview | null
  busy: boolean
  onRun: () => void
  onFix: (findingId: string) => void
  onLocate?: (changeId: string) => void
  changes: WireChange[]
}): ReactElement {
  const { review, busy, onRun, onFix, onLocate, changes } = props
  const findings = review?.findings ?? []
  return card('AI 摘要',
    createElement('div', null,
      // 按需增强(V-6):未审查 → 「Review changes」CTA;已审查 → 「重新审查」。
      createElement('button', { onClick: onRun, disabled: busy, className: baseCss.buttonGhost },
        busy ? 'AI 审查中…' : review === null ? '运行审查' : '重新审查'),
      review === null
        ? createElement('div', { className: `${baseCss.muted} ${css.cardBody}` }, '点击运行 AI 审查,结果为辅助信息,不改变变更状态')
        : createElement('div', { className: css.cardBody },
          createElement('div', { className: css.reviewSummaryLine },
            createElement(RiskSignal, { level: riskSignalLevel(review.risk), hint: `AI 审查风险：${RISK_ZH[review.risk] ?? review.risk}` }),
            createElement('span', { className: `${baseCss.muted} ${css.cardBodyTight}` },
              findings.length === 0 ? '✓ 未发现明显问题' : `${findings.length} 条发现`),
          ),
          // 4.x:AI 置信度 + 建议动作(Linear/Raycast 风格)。
          createElement('div', { className: css.confidenceRow },
            createElement('span', { className: css.confidenceLabel }, 'AI 置信度'),
            createElement('div', { className: css.confidenceBar },
              createElement('div', { className: css.confidenceFill, style: { width: `${clampScore(review.score)}%` } }),
            ),
            createElement('span', { className: css.confidenceValue }, `${clampScore(review.score)}%`),
          ),
          createElement('div', { className: css.suggestRow },
            createElement('span', { className: css.suggestTag }, '建议'),
            createElement('span', { className: css.suggestText }, suggestAction(review.risk)),
          ),
          review.summary.length > 0
            ? createElement('div', { className: `${baseCss.muted} ${css.cardBodyTight}` }, review.summary)
            : null,
          createElement('div', { className: css.cardBodyTight },
            findings.slice(0, 5).map(finding => {
              const located = locateChange(changes, finding.filePath)
              return createElement('div', {
                key: finding.id,
                className: located !== undefined && onLocate !== undefined ? css.findingRowLink : css.findingRow,
                onClick: located !== undefined && onLocate !== undefined ? () => onLocate(located.id) : undefined,
                title: located !== undefined ? '点击定位到变更' : undefined,
              },
              createElement('span', { className: css.findingTitle, style: { color: findingColor(finding.severity) } },
                `${SEVERITY_ZH[finding.severity] ?? finding.severity} ${finding.filePath}${finding.line !== undefined ? `:${finding.line}` : ''}`),
              ` ${finding.title}`,
              (finding.severity === 'error' || finding.severity === 'critical')
                ? createElement('button', {
                  onClick: (event: MouseEvent) => { event.stopPropagation(); onFix(finding.id) },
                  disabled: busy,
                  className: `${baseCss.buttonMini} ${css.findingFix}`,
                }, 'AI 修复')
                : null,
              )
            }),
            findings.length > 5
              ? createElement('div', { className: `${baseCss.muted} ${css.cardBodyTight}` }, `… 共 ${findings.length} 条`)
              : null,
          ),
        ),
    ),
  )
}

/** 4.x 建议动作:按风险等级给出下一步(辅助决策,不阻断)。 */
function suggestAction(risk: string): string {
  switch (risk) {
    case 'critical': return '建议逐条确认，高风险项可拒绝'
    case 'high': return '建议确认风险后再应用'
    case 'medium': return '建议逐条确认后应用'
    default: return '可以全部应用'
  }
}

/** 0-100 收敛(置信度/评分展示用)。 */
function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)))
}

/** Map a finding's severity to the three-level signal. */
function riskSignalLevel(level: string): SignalLevel {
  if (level === 'critical' || level === 'high') return 'warn'
  if (level === 'medium') return 'warn'
  return 'ok'
}

/** Locate the deduped change whose path matches a finding filePath. */
function locateChange(changes: WireChange[], findingPath: string): WireChange | undefined {
  if (findingPath.length === 0) return undefined
  return changes.find(change => findingPathMatches(change.path, findingPath))
}

function findingColor(severity: string): string {
  switch (severity) {
    case 'critical': return 'var(--dsw-alias-state-error-primary)'
    case 'error': return 'var(--dsw-alias-state-error-primary)'
    case 'warning': return 'var(--dsw-alias-state-warn-primary)'
    default: return 'var(--dsw-alias-label-tertiary)'
  }
}

/** Match a change path against a finding path (suffix or exact). */
function findingPathMatches(changePath: string, findingPath: string): boolean {
  if (findingPath.length === 0) return false
  return changePath === findingPath || changePath.endsWith(findingPath)
}

function RiskCard(props: { risk: WireRisk | null; busy: boolean; onAnalyze: () => void }): ReactElement {
  const { risk, busy, onAnalyze } = props
  return card('风险',
    createElement('div', null,
      createElement('button', { onClick: onAnalyze, disabled: busy, className: baseCss.buttonGhost }, busy ? '分析中…' : '分析'),
      risk === null
        ? createElement('div', { className: `${baseCss.muted} ${css.cardBody}` }, '未分析')
        : createElement('div', { className: css.cardBody },
          // V-5:默认不给数字评分,只给三级信号 + 一句话原因。
          createElement('div', { className: css.reviewSummaryLine },
            createElement(RiskSignal, {
              level: riskSignalLevel(risk.level),
              hint: risk.reasons[0]?.detail ?? `风险等级：${RISK_ZH[risk.level] ?? risk.level}`,
            }),
            createElement('span', null, RISK_ZH[risk.level] ?? risk.level),
          ),
          risk.reasons.length > 0
            ? createElement('ul', { className: css.riskReasons },
              risk.reasons.map((reason, index) => createElement('li', { key: `${reason.rule}-${index}`, className: css.riskReason },
                createElement('b', null, reason.rule), ` — ${reason.detail}`,
              )),
            )
            : null,
        ),
    ),
  )
}

function VerificationCard(props: { tasks: WireVerificationTask[]; busy: boolean; onRun: () => void }): ReactElement {
  const { tasks, busy, onRun } = props
  return card('验证',
    createElement('div', null,
      createElement('button', { onClick: onRun, disabled: busy, className: baseCss.buttonGhost }, busy ? '运行中…' : '运行验证'),
      tasks.length === 0
        ? createElement('div', { className: `${baseCss.muted} ${css.cardBody}` }, '暂无验证')
        : createElement('div', { className: css.cardBody },
          tasks.slice(0, 5).map(task => createElement('div', { key: task.id, className: css.taskRow },
            createElement('span', { style: statusColor(task.status) }, `${statusIcon(task.status)} ${statusZh(task.status)}`),
            ` ${task.command}`,
          )),
        ),
    ),
  )
}

function statusZh(status: string): string {
  switch (status) {
    case 'passed': return '通过'
    case 'failed': return '失败'
    case 'running': return '运行中'
    case 'cancelled': return '已取消'
    default: return '待执行'
  }
}

function TimelineCard(props: { events: WireHistoryEvent[]; changes: WireChange[] }): ReactElement {
  const { events, changes } = props
  return card('时间线',
    createElement('div', { className: css.timelineList },
      createElement(TimelineView, { events, changes }),
    ),
  )
}

function statusIcon(status: string): string {
  switch (status) {
    case 'passed': return '✓'
    case 'failed': return '✗'
    case 'running': return '…'
    default: return '○'
  }
}

function statusColor(status: string): Record<string, string> {
  switch (status) {
    case 'passed': return { color: 'var(--dsw-alias-state-success-primary)' }
    case 'failed': return { color: 'var(--dsw-alias-state-error-primary)' }
    default: return { color: 'var(--dsw-alias-label-tertiary)' }
  }
}

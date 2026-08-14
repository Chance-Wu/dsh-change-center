/**
 * Intelligence panel: the phase-3 right column — git facts, AI review,
 * risk, verification, policy, and timeline, stacked as collapsible cards. 界面文案默认中文，样式对齐 Harness 设计 token。
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ChangeCenterApi, GitResponse, JobHandle, WireHistoryEvent, WireReview, WireRisk, WireVerificationTask } from './index.ts'
import { PolicyPanel } from './PolicyPanel.tsx'
import { RISK_ZH } from './i18n.ts'
import baseCss from './styles.module.css'
import css from './IntelligencePanel.module.css'

/** Props for the intelligence panel. */
export interface IntelligencePanelProps {
  sessionId: string
  workspace: string
  api: ChangeCenterApi
  onChanged: () => void
}

const RISK_COLOR: Record<string, string> = {
  low: 'var(--dsw-alias-state-success-primary)',
  medium: 'var(--dsw-alias-state-warn-primary)',
  high: 'var(--dsw-alias-state-warn-primary)',
  critical: 'var(--dsw-alias-state-error-primary)',
}

/** Right-column intelligence cards. */
export function IntelligencePanel(props: IntelligencePanelProps): ReactElement {
  const { sessionId, workspace, api, onChanged } = props
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
        setLoopMessage(`修复循环结束：${r.result.stopped}，共 ${r.result.iterations} 轮`)
      }
    })
  }

  return createElement('div', { className: css.panel },
    error !== null ? createElement('div', { className: css.panelError }, error) : null,
    createElement('div', { className: css.loopRow },
      createElement('button', { onClick: runLoop, disabled: busy, className: baseCss.buttonGhost }, busy ? '运行中…' : '运行修复循环'),
      jobRunning
        ? createElement('button', { onClick: cancelCurrent, className: baseCss.buttonDanger }, '取消')
        : null,
      loopMessage !== null ? createElement('span', { className: css.loopMessage }, loopMessage) : null,
    ),
    createElement(GitCard, { git, workspace }),
    createElement(ReviewCard, {
      review, busy, onRun: () => run(() => api.reviewRun(sessionId)),
      onFix: (findingId) => {
        // Fix the first file change matching the finding path.
        api.sessionChanges(sessionId).then(changes => {
          const change = changes.find(c => c.kind === 'file' && findingPathMatches(c.path, review?.findings.find(f => f.id === findingId)?.filePath ?? ''))
          if (change === undefined) {
            setError('没有与这条发现匹配的文件变更')
            return
          }
          run(() => api.fixRun(sessionId, review?.sessionId ?? sessionId, findingId, change.id))
        }).catch(err => setError(err instanceof Error ? err.message : String(err)))
      },
    }),
    createElement(RiskCard, { risk, busy, onAnalyze: () => run(() => api.riskAnalyze(sessionId)) }),
    createElement(VerificationCard, { tasks: verification, busy, onRun: () => run(() => api.verificationRun(sessionId)) }),
    createElement(PolicyPanel, { sessionId, api, onChanged }),
    createElement(TimelineCard, { events: timeline }),
  )
}

/** 可折叠卡片容器：点击标题展开/收起。 */
function Collapsible(props: { title: string; children: (expanded: boolean) => ReactElement }): ReactElement {
  const [expanded, setExpanded] = useState(true)
  return createElement('div', { className: baseCss.card },
    createElement('button', {
      onClick: () => setExpanded(!expanded),
      className: baseCss.cardTitleButton,
    }, `${expanded ? '▾' : '▸'} ${props.title}`),
    expanded ? createElement('div', { className: css.cardBody }, props.children(true)) : null,
  )
}

function card(title: string, children: ReactElement | ReactElement[] | string): ReactElement {
  return createElement('div', { className: baseCss.card },
    createElement('div', { className: baseCss.cardTitle }, title),
    createElement('div', { className: css.cardBody }, children),
  )
}

function GitCard(props: { git: GitResponse | null; workspace: string }): ReactElement {
  const { git, workspace } = props
  const repo = git?.repo
  const notGit = repo !== undefined && 'error' in repo
  return card('Git',
    notGit
      ? createElement('div', { className: baseCss.muted }, '不是 Git 仓库')
      : createElement('div', { className: css.smallText },
        createElement('div', null, '分支：', createElement('b', null, repo && 'branch' in repo ? repo.branch : '—')),
        createElement('div', null, 'HEAD：', createElement('b', null, repo && 'head' in repo ? repo.head : '—')),
        createElement('div', null, repo && 'dirty' in repo ? (repo.dirty ? '● 有未提交修改' : '○ 干净') : ''),
        createElement('div', { className: `${baseCss.muted} ${css.cardBodyTight}` }, workspace),
      ),
  )
}

function ReviewCard(props: {
  review: WireReview | null
  busy: boolean
  onRun: () => void
  onFix: (findingId: string) => void
}): ReactElement {
  const { review, busy, onRun, onFix } = props
  return card('AI 审查',
    createElement('div', null,
      createElement('button', { onClick: onRun, disabled: busy, className: baseCss.buttonGhost }, busy ? '运行中…' : '运行审查'),
      review === null
        ? createElement('div', { className: `${baseCss.muted} ${css.cardBody}` }, '暂无审查')
        : createElement('div', { className: css.cardBody },
          createElement('div', null,
            '风险：', createElement('b', { style: { color: RISK_COLOR[review.risk] ?? undefined } }, RISK_ZH[review.risk] ?? review.risk),
            ` · 评分 ${review.score}/100`),
          review.summary.length > 0
            ? createElement('div', { className: `${baseCss.muted} ${css.cardBodyTight}` }, review.summary)
            : null,
          createElement('div', { className: css.cardBodyTight },
            review.findings.slice(0, 5).map(finding => createElement('div', { key: finding.id, className: css.findingRow },
              createElement('span', { className: css.findingTitle, style: { color: findingColor(finding.severity) } },
                `${finding.severity.toUpperCase()} ${finding.filePath}${finding.line !== undefined ? `:${finding.line}` : ''}`),
              ` ${finding.title}`,
              (finding.severity === 'error' || finding.severity === 'critical')
                ? createElement('button', {
                  onClick: () => onFix(finding.id),
                  disabled: busy,
                  className: `${baseCss.buttonMini} ${css.findingFix}`,
                }, 'AI 修复')
                : null,
            )),
          ),
        ),
    ),
  )
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
          createElement('div', null,
            createElement('b', { style: { color: RISK_COLOR[risk.level] ?? undefined } }, RISK_ZH[risk.level] ?? risk.level),
            ` · 评分 ${risk.score}`),
          risk.reasons.length > 0
            ? createElement('div', { className: `${baseCss.muted} ${css.cardBodyTight}` }, risk.reasons.map(r => r.rule).join(', '))
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

function TimelineCard(props: { events: WireHistoryEvent[] }): ReactElement {
  const { events } = props
  return card('时间线',
    events.length === 0
      ? createElement('div', { className: baseCss.muted }, '暂无事件')
      : createElement('div', { className: css.timelineList },
        events.map(event => createElement('div', { key: event.id, className: css.timelineRow },
          createElement('span', { className: css.timelineTime }, timeOf(event.timestamp)),
          ` ${event.actor === 'agent' ? '代理' : event.actor === 'user' ? '用户' : '系统'} ${eventTypeZh(event.type)}`,
        )),
      ),
  )
}

function eventTypeZh(type: string): string {
  switch (type) {
    case 'created': return '创建'
    case 'reviewed': return '审查'
    case 'approved': return '批准'
    case 'rejected': return '拒绝'
    case 'applied': return '应用'
    case 'verified': return '验证'
    case 'rolled_back': return '回滚'
    case 'committed': return '提交'
    default: return type
  }
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

function timeOf(timestamp: number): string {
  const date = new Date(timestamp)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

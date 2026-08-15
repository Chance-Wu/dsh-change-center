/**
 * Policy panel: lists change policies with enable toggles and policy
 * evaluation results for the selected session.
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useState, type ReactElement } from 'react'
import type { ChangeCenterApi, WirePolicy, WirePolicyEvaluation } from './index.ts'
import { POLICY_ACTION_ZH, POLICY_NAME_ZH, UNKNOWN_ZH } from './i18n.ts'
import baseCss from './styles.module.css'
import css from './PolicyPanel.module.css'

/** Props for the policy panel. */
export interface PolicyPanelProps {
  sessionId: string | null
  api: ChangeCenterApi
  onChanged: () => void
}

/** Policy list with enable toggles and per-session evaluation results. */
export function PolicyPanel(props: PolicyPanelProps): ReactElement {
  const { sessionId, api, onChanged } = props
  const [policies, setPolicies] = useState<WirePolicy[]>([])
  const [evaluations, setEvaluations] = useState<WirePolicyEvaluation[]>([])

  useEffect(() => {
    api.policies().then(setPolicies).catch(() => setPolicies([]))
  }, [])

  useEffect(() => {
    if (sessionId === null) {
      setEvaluations([])
      return
    }
    api.policyEvaluation(sessionId)
      .then(({ evaluations }) => setEvaluations(evaluations))
      .catch(() => setEvaluations([]))
  }, [sessionId])

  const toggle = (policy: WirePolicy): void => {
    api.policySave({ ...policy, enabled: !policy.enabled })
      .then(list => { setPolicies(list); onChanged() })
      .catch(() => onChanged())
  }

  return createElement('div', { className: baseCss.card },
    createElement('div', { className: baseCss.cardTitle }, '策略'),
    createElement('div', { className: css.list },
      policies.map(policy => createElement('div', { key: policy.id, className: css.row },
        createElement('input', {
          type: 'checkbox',
          checked: policy.enabled,
          onChange: () => toggle(policy),
          className: css.toggle,
        }),
        createElement('div', { className: css.info },
          createElement('div', { className: css.name }, POLICY_NAME_ZH[policy.id] ?? policy.name),
          createElement('div', { className: css.meta },
            `${POLICY_ACTION_ZH[policy.action] ?? UNKNOWN_ZH} · 优先级 ${policy.priority}`),
        ),
      )),
    ),
    // 当前会话命中的策略（评估结果）。
    evaluations.length > 0
      ? createElement('div', { className: css.evalBlock },
        createElement('div', { className: css.evalTitle }, '本会话命中'),
        evaluations.map(evaluation => createElement('div', { key: `${evaluation.policyId}-${evaluation.action}`, className: css.evalRow },
          createElement('span', { className: evaluation.action === 'deny' ? css.evalDeny : evaluation.action === 'warn' ? css.evalWarn : css.evalOk },
            POLICY_ACTION_ZH[evaluation.action] ?? UNKNOWN_ZH),
          createElement('span', { className: css.evalName },
            POLICY_NAME_ZH[evaluation.policyId] ?? evaluation.policyId),
        )),
      )
      : null,
  )
}

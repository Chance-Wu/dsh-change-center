/**
 * Policy panel: lists change policies with enable toggles and policy
 * evaluation results for the selected session.
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useState, type ReactElement } from 'react'
import type { ChangeCenterApi, WirePolicy } from './index.ts'
import { POLICY_ACTION_ZH, POLICY_NAME_ZH } from './i18n.ts'
import baseCss from './styles.module.css'
import css from './PolicyPanel.module.css'

/** Props for the policy panel. */
export interface PolicyPanelProps {
  sessionId: string | null
  api: ChangeCenterApi
  onChanged: () => void
}

/** Policy list with enable toggles. */
export function PolicyPanel(props: PolicyPanelProps): ReactElement {
  const { api, onChanged } = props
  const [policies, setPolicies] = useState<WirePolicy[]>([])

  useEffect(() => {
    api.policies().then(setPolicies).catch(() => setPolicies([]))
  }, [])

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
            `${POLICY_ACTION_ZH[policy.action] ?? policy.action} · 优先级 ${policy.priority}`),
        ),
      )),
    ),
  )
}

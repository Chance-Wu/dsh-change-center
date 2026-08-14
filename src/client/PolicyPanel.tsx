/**
 * Policy panel: lists change policies with enable toggles and policy
 * evaluation results for the selected session.
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useState, type ReactElement } from 'react'
import type { ChangeCenterApi, WirePolicy } from './index.ts'
import { POLICY_ACTION_ZH, POLICY_NAME_ZH } from './i18n.ts'
import baseCss from './styles.module.css'

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
    createElement('div', { style: { marginTop: 6 } },
      policies.map(policy => createElement('div', { key: policy.id, style: rowStyle },
        createElement('input', {
          type: 'checkbox',
          checked: policy.enabled,
          onChange: () => toggle(policy),
          style: { cursor: 'pointer' },
        }),
        createElement('div', { style: { flex: 1, minWidth: 0 } },
          createElement('div', { style: { fontSize: 12, fontWeight: 600 } }, POLICY_NAME_ZH[policy.id] ?? policy.name),
          createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
            `${POLICY_ACTION_ZH[policy.action] ?? policy.action} · 优先级 ${policy.priority}`),
        ),
      )),
    ),
  )
}

const rowStyle: Record<string, string | number> = {
  display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0',
}

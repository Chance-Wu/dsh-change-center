/**
 * Risk signal (Vibe UI, V-5): the three-level visual signal that replaces
 * numeric risk scores in the default UI — ✓ normal / ⚠ needs attention /
 * ⛔ blocks apply. Hover shows one reason; clicking opens the full detail
 * (the More panel). The host risk model is untouched; this is presentation.
 * @module dsh-change-center/client
 */

import { createElement, type ReactElement } from 'react'
import { IconAlertCircle, IconBan, IconCheckCircle } from './icons.tsx'
import css from './RiskSignal.module.css'

/** The three signal levels. */
export type SignalLevel = 'ok' | 'warn' | 'block'

/** Props for the risk signal. */
export interface RiskSignalProps {
  level: SignalLevel
  /** Optional count shown next to the glyph (e.g. number of issues). */
  count?: number
  /** One-line reason shown on hover (not always visible). */
  hint?: string
}

const GLYPH: Record<SignalLevel, ReactElement> = {
  ok: createElement(IconCheckCircle, null),
  warn: createElement(IconAlertCircle, null),
  block: createElement(IconBan, null),
}
const CLASS: Record<SignalLevel, string> = { ok: css.ok, warn: css.warn, block: css.block }

/** Compact ✓/⚠/⛔ signal with an optional count badge and hover reason. */
export function RiskSignal(props: RiskSignalProps): ReactElement {
  const { level, count, hint } = props
  return createElement('span', {
    className: `${css.signal} ${CLASS[level]}`,
    title: hint,
    'aria-label': hint ?? (level === 'block' ? '阻止应用' : level === 'warn' ? '需要注意' : '正常'),
  },
  createElement('span', { className: css.glyph }, GLYPH[level]),
  count !== undefined && count > 0
    ? createElement('span', { className: css.count }, count)
    : null,
  )
}

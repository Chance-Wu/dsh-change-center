/**
 * Error boundary for the change review surface: any uncaught render error
 * shows a recoverable message instead of blanking the whole page. 「重试」
 * re-renders the subtree.
 * @module dsh-change-center/client
 */

import { Component, createElement, type ReactNode } from 'react'

interface ErrorBoundaryState {
  error: Error | null
}

/** Catches render errors from the subtree and offers a retry. */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return createElement('div', {
        style: {
          padding: '16px',
          border: '1px solid var(--dsw-alias-state-error-primary)',
          borderRadius: '10px',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'inherit',
        },
      },
      createElement('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' } },
        '变更页面渲染出错'),
      createElement('pre', {
        style: {
          margin: '8px 0',
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }, String(this.state.error)),
      createElement('button', {
        onClick: () => this.setState({ error: null }),
        style: {
          cursor: 'pointer',
          padding: '4px 12px',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '6px',
          background: 'var(--dsw-alias-bg-layer-3)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'inherit',
        },
      }, '重试'),
      )
    }
    return this.props.children
  }
}

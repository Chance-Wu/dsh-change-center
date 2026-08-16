/**
 * Error boundary for the change review surface: any uncaught render error
 * shows a recoverable message instead of blanking the whole page. 「重试」
 * re-renders the subtree.
 * @module dsh-change-center/client
 */

import { Component, createElement, type ReactNode } from 'react'
import baseCss from './styles.module.css'
import css from './ErrorBoundary.module.css'

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
      return createElement('div', { className: css.box },
        createElement('div', { className: css.title }, '变更页面渲染出错'),
        createElement('pre', { className: css.detail }, String(this.state.error)),
        createElement('button', {
          onClick: () => this.setState({ error: null }),
          className: baseCss.buttonGhost,
        }, '重试'),
      )
    }
    return this.props.children
  }
}

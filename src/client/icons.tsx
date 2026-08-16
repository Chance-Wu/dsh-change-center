/**
 * 共享内联图标集：stroke 风格 SVG（对齐设计 token，不依赖外部图标库）。
 * 折叠箭头统一用 Chevron（展开 = 右转 90°），替换 Unicode 文本字形（▾/▸）。
 * @module dsh-change-center/client
 */

import { createElement, type ReactElement } from 'react'

/** 16 viewBox stroke 图标基座。 */
function Svg(props: { d: string[]; size?: number }): ReactElement {
  return createElement('svg', {
    viewBox: '0 0 24 24',
    width: props.size ?? 14,
    height: props.size ?? 14,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }, props.d.map(d => createElement('path', { key: d, d })))
}

/** 折叠箭头：`expanded=false` 指向右（可展开），`expanded=true` 指向下（可收起）。 */
export function Chevron(props: { expanded: boolean; size?: number }): ReactElement {
  return createElement('svg', {
    viewBox: '0 0 16 16',
    width: props.size ?? 12,
    height: props.size ?? 12,
    'aria-hidden': true,
    style: {
      flex: 'none',
      opacity: 0.65,
      transform: props.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 140ms ease',
    },
  },
  createElement('path', {
    d: 'M6 4l4 4-4 4',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }))
}

/** 圆圈对勾（风险信号 ok）。 */
export function IconCheckCircle(props: { size?: number }): ReactElement {
  return createElement(Svg, { size: props.size, d: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'm9 12 2 2 4-4'] })
}

/** 圆圈感叹（风险信号 warn）。 */
export function IconAlertCircle(props: { size?: number }): ReactElement {
  return createElement(Svg, { size: props.size, d: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 8v4', 'M12 16h.01'] })
}

/** 圆圈斜杠（风险信号 block：禁止应用）。 */
export function IconBan(props: { size?: number }): ReactElement {
  return createElement(Svg, { size: props.size, d: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'm5.6 5.6 12.8 12.8'] })
}

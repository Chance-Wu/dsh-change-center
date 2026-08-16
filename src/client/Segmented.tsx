/**
 * 液态分段控件:激活项由一个滑动胶囊指示器标出,切换时平滑滑动
 * (overshoot 弹性曲线);供 Issues 过滤器(全部/待处理/问题)与
 * Diff 模式(统一/并排/编辑)共用。
 * @module dsh-change-center/client
 */

import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import css from './Segmented.module.css'

export interface Segment {
  value: string
  label: string
}

/** Props for the segmented control. */
export interface SegmentedProps {
  segments: Segment[]
  value: string
  onChange: (value: string) => void
}

/** 液态分段控件:指示胶囊跟随激活项滑动。 */
export function Segmented(props: SegmentedProps): ReactElement {
  const { segments, value, onChange } = props
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })

  useEffect(() => {
    const track = trackRef.current
    if (track === null) return
    const activeEl = Array.from(track.querySelectorAll<HTMLElement>('[data-active="true"]'))[0]
    if (activeEl === undefined) return
    const trackRect = track.getBoundingClientRect()
    const rect = activeEl.getBoundingClientRect()
    setIndicator({ left: rect.left - trackRect.left, width: rect.width })
  }, [value, segments])

  return createElement('div', { className: css.segmented, ref: trackRef },
    // 滑动指示胶囊(absolute,transform 驱动 → GPU 合成,平滑)。
    createElement('span', {
      className: css.indicator,
      style: { transform: `translateX(${indicator.left}px)`, width: indicator.width },
    }),
    segments.map(segment => createElement('button', {
      key: segment.value,
      className: css.segBtn,
      'data-active': segment.value === value,
      onClick: () => onChange(segment.value),
    }, segment.label)),
  )
}

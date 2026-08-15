/**
 * 界面文案（默认中文）。
 *
 * 插件面向中文用户，UI 文案直接硬编码为简体中文；风险等级、策略名等
 * 来自 host 的英文数据，在 client 侧做中文映射，不改 host 数据面。
 * @module dsh-change-center/client
 */

/** 风险等级 → 中文。 */
export const RISK_ZH: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '严重',
}

/**
 * 变更操作标记（文件树徽标）。只保留文件操作：命令执行（execute）不是
 * 真正的文件变更，已被过滤出审查界面，不再出现在文件树中。
 */
export const OPERATION_MARK: Record<string, string> = {
  create: 'A',
  modify: 'M',
  delete: 'D',
  rename: 'R',
}

/** 内置策略 id → 中文名（host 数据面保持英文，这里展示时映射）。 */
export const POLICY_NAME_ZH: Record<string, string> = {
  'deny-core-delete': '禁止删除核心文件',
}

/** 策略动作 → 中文。 */
export const POLICY_ACTION_ZH: Record<string, string> = {
  allow: '允许',
  warn: '警告',
  require_approval: '需要审批',
  deny: '拒绝',
}

/** AI 审查发现严重程度 → 中文。 */
export const SEVERITY_ZH: Record<string, string> = {
  critical: '严重',
  error: '错误',
  warning: '警告',
  info: '提示',
}

/** 修复循环停止原因 → 中文。 */
export const LOOP_STOPPED_ZH: Record<string, string> = {
  pass: '全部通过',
  'limit-reached': '达到迭代上限',
  'no-fixable-findings': '无待修复问题',
  cancelled: '已取消',
}

/** 未知枚举回退文案（避免界面直接出现英文原始值）。 */
export const UNKNOWN_ZH = '未知'

/**
 * Client entry for session summaries: re-exports the single shared
 * implementation in `models/sessionSummary.ts` (host 持久化与客户端兜底共用，
 * 3.x 摘要质量提升)。
 * @module dsh-change-center/client
 */

export { summarizeChanges } from '../models/sessionSummary.ts'
export type { SummarizableChange } from '../models/sessionSummary.ts'

/**
 * JSONL store: append-oriented durable persistence for the in-memory change
 * stores, written through the `ctx.fs` seam (atomic writes, sandbox/approval
 * aware).
 *
 * Records are stored one JSON object per line under
 * `$DSH_HOME/change-center/store/`. The store is best-effort: when no `fs`
 * service is mounted (headless/pure-state-machine compositions) it is a
 * silent no-op, keeping the in-memory services fully functional.
 * @module dsh-change-center/services
 */

import type { FileSystem } from '@deepseek-ai/dsh-fs'

/**
 * A line-based JSON store for one collection of records.
 * @typeParam T - the record shape; records must serialize to JSON.
 */
export class JsonlStore<T> {
  private chain: Promise<void> = Promise.resolve()

  constructor(
    /** Resolver for the `fs` service at call time (may be undefined). */
    private readonly getFs: () => FileSystem | undefined,
    /** Absolute path of the JSONL file. */
    private readonly file: string,
  ) {}

  /** Read all records; a missing or corrupt store yields []. */
  async load(): Promise<T[]> {
    const fs = this.getFs()
    if (fs === undefined) return []
    try {
      const target = await fs.resolve(this.file)
      if (await fs.stat(target) === undefined) return []
      const raw = await fs.readText(target)
      const records: T[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          records.push(JSON.parse(trimmed) as T)
        } catch {
          // Skip corrupt lines; keep the rest of the store readable.
        }
      }
      return records
    } catch {
      return []
    }
  }

  /**
   * Rewrite the store with the given records. Writes are serialized (chained)
   * so concurrent mutations cannot interleave; failures are best-effort and
   * never poison the chain.
   */
  save(records: T[]): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        const fs = this.getFs()
        if (fs === undefined) return
        const target = await fs.resolve(this.file)
        const body = records.length === 0 ? '' : `${records.map(record => JSON.stringify(record)).join('\n')}\n`
        await fs.writeText(target, body)
      } catch {
        // Best-effort persistence: the in-memory store remains authoritative.
      }
    })
    return this.chain
  }
}

/** Parse the numeric suffix of an id like `change-12` to restore counters. */
export function maxIdSuffix(ids: string[], prefix: string): number {
  let max = 0
  for (const id of ids) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id)
    if (match !== null) {
      const value = Number(match[1])
      if (value > max) max = value
    }
  }
  return max
}

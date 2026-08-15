/**
 * HTTP API for the change center, served through the Harness web server.
 *
 * Registered as a prefix route under `/api/change-center` — the webserver's
 * longest-prefix-wins matching routes these before the connection layer's
 * bare `/api` bridge, so no RPC plumbing is needed. The browser client half
 * calls these endpoints same-origin.
 * @module dsh-change-center/api
 */

import type { Context, Events } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.webServer` Context merge into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

const PREFIX = '/api/change-center'

/** POST bodies larger than this are rejected with 413. */
const MAX_BODY_BYTES = 1024 * 1024
const BODY_TOO_LARGE = 'request body exceeds 1MB limit'

/** Defaults and bounds for `limit`/`offset` list pagination. */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

/** Events forwarded to `/events` SSE clients. */
const SSE_EVENTS = [
  'change:created', 'change:approved', 'change:rejected', 'change:applied',
  'change:failed', 'change:rollback', 'change-session:created', 'change-session:status',
  'change:reviewed', 'verification:completed', 'history:recorded', 'job:settled',
] as const

/** Currently connected SSE clients; written on every forwarded event. */
const sseClients = new Set<ServerResponse>()

/**
 * Register the change-center REST surface. Actions are status-machine
 * transitions on the in-memory store; payloads are plain JSON. Long-running
 * actions (verification/review/fix/loop) submit background jobs and return
 * immediately; their progress is observable through the jobs API and the
 * `/events` SSE stream.
 * @param ctx - host context providing the change services and web server.
 */
export function applyRoutes(ctx: Context): void {
  // The web server exists only in the web profile; without it there is no
  // HTTP surface, which is fine for headless assemblies. The change services
  // are injected here so route handlers may read them on the same context.
  ctx.inject([
    'webServer', 'changeCenter', 'changeSessions', 'jobs',
    'git', 'verification', 'aiReview', 'risk', 'changeHistory',
    'policies', 'aiFix', 'fixLoop',
  ], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => {
        void handle(req, res, webCtx)
      },
    }), 'change-center: api routes')
    // Forward the plugin's own events to SSE subscribers on the same context.
    for (const event of SSE_EVENTS) {
      webCtx.on(event as keyof Events, ((...args: unknown[]) => {
        const data = `event: ${event}\ndata: ${JSON.stringify(args)}\n\n`
        for (const client of sseClients) {
          try { client.write(data) } catch { /* client gone */ }
        }
      }) as never)
    }
  })
}

/** Parsed route: the action to run plus any captured segment values. */
type Parsed =
  | { kind: 'sessions' }
  | { kind: 'session'; id: string }
  | { kind: 'session-changes'; id: string }
  | { kind: 'session-action'; id: string; action: 'accept-all' | 'reject-all' | 'accept-all-apply' | 'rollback-all' }
  | { kind: 'git'; id: string; action: 'status' | 'diff' | 'log' }
  | { kind: 'verification'; id: string; action: 'run' | 'list' }
  | { kind: 'review'; id: string; action: 'run' | 'get' }
  | { kind: 'risk'; id: string; action: 'analyze' | 'get' }
  | { kind: 'history'; id: string; action: 'history' | 'timeline' }
  | { kind: 'fix'; id: string; action: 'run' | 'list' }
  | { kind: 'loop'; id: string }
  | { kind: 'job'; id: string }
  | { kind: 'job-action'; id: string; action: 'cancel' }
  | { kind: 'session-jobs'; id: string }
  | { kind: 'events' }
  | { kind: 'policies'; action: 'list' | 'create' }
  | { kind: 'policy'; id: string; action: 'update' | 'delete' }
  | { kind: 'changes' }
  | { kind: 'change'; id: string }
  | { kind: 'change-action'; id: string; action: 'approve' | 'reject' | 'apply' | 'rollback' | 'edit' | 'repend' }
  | { kind: 'not-found' }

/** One compiled route rule: anchored regex over the path after the prefix. */
interface RouteRule {
  re: RegExp
  build: (match: RegExpMatchArray) => Parsed
}

/**
 * Table-driven route matcher. Rules are anchored and tried in order; the
 * first match wins. Each rule captures path segments into a {@link Parsed}.
 */
const ROUTE_RULES: RouteRule[] = [
  { re: /^\/policies\/?$/, build: () => ({ kind: 'policies', action: 'list' }) },
  { re: /^\/policies\/([^/]+)\/(update|delete)$/, build: m => ({ kind: 'policy', id: m[1]!, action: m[2] as 'update' | 'delete' }) },
  { re: /^\/sessions\/?$/, build: () => ({ kind: 'sessions' }) },
  { re: /^\/sessions\/([^/]+)$/, build: m => ({ kind: 'session', id: m[1]! }) },
  { re: /^\/sessions\/([^/]+)\/changes$/, build: m => ({ kind: 'session-changes', id: m[1]! }) },
  { re: /^\/sessions\/([^/]+)\/(accept-all|reject-all|accept-all-apply|rollback-all)$/, build: m => ({ kind: 'session-action', id: m[1]!, action: m[2] as 'accept-all' | 'reject-all' | 'accept-all-apply' | 'rollback-all' }) },
  { re: /^\/sessions\/([^/]+)\/git\/?(diff|log|status)?$/, build: m => ({ kind: 'git', id: m[1]!, action: (m[2] ?? 'status') as 'status' | 'diff' | 'log' }) },
  { re: /^\/sessions\/([^/]+)\/verification\/?(run)?$/, build: m => ({ kind: 'verification', id: m[1]!, action: (m[2] ?? 'list') as 'run' | 'list' }) },
  { re: /^\/sessions\/([^/]+)\/review\/?(run)?$/, build: m => ({ kind: 'review', id: m[1]!, action: (m[2] ?? 'get') as 'run' | 'get' }) },
  { re: /^\/sessions\/([^/]+)\/risk\/?(analyze)?$/, build: m => ({ kind: 'risk', id: m[1]!, action: (m[2] ?? 'get') as 'analyze' | 'get' }) },
  { re: /^\/sessions\/([^/]+)\/history\/?(timeline)?$/, build: m => ({ kind: 'history', id: m[1]!, action: (m[2] ?? 'history') as 'history' | 'timeline' }) },
  { re: /^\/sessions\/([^/]+)\/fix\/?(run)?$/, build: m => ({ kind: 'fix', id: m[1]!, action: (m[2] ?? 'list') as 'run' | 'list' }) },
  { re: /^\/sessions\/([^/]+)\/loop\/run$/, build: m => ({ kind: 'loop', id: m[1]! }) },
  { re: /^\/sessions\/([^/]+)\/jobs$/, build: m => ({ kind: 'session-jobs', id: m[1]! }) },
  { re: /^\/jobs\/([^/]+)$/, build: m => ({ kind: 'job', id: m[1]! }) },
  { re: /^\/jobs\/([^/]+)\/cancel$/, build: m => ({ kind: 'job-action', id: m[1]!, action: 'cancel' }) },
  { re: /^\/events\/?$/, build: () => ({ kind: 'events' }) },
  { re: /^\/changes\/?$/, build: () => ({ kind: 'changes' }) },
  { re: /^\/changes\/([^/]+)$/, build: m => ({ kind: 'change', id: m[1]! }) },
  { re: /^\/changes\/([^/]+)\/(approve|reject|apply|rollback|edit|repend)$/, build: m => ({ kind: 'change-action', id: m[1]!, action: m[2] as 'approve' | 'reject' | 'apply' | 'rollback' | 'edit' | 'repend' }) },
]

/** Parse a change-center pathname into a {@link Parsed} route. */
export function parsePath(pathname: string): Parsed {
  const rest = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname
  for (const rule of ROUTE_RULES) {
    const match = rule.re.exec(rest)
    if (match !== null) return rule.build(match)
  }
  return { kind: 'not-found' }
}

/** Whether a parsed route is a GET (read) endpoint vs a POST action. */
function isReadRoute(parsed: Parsed): boolean {
  switch (parsed.kind) {
    case 'sessions':
    case 'session':
    case 'session-changes':
    case 'changes':
    case 'change':
    case 'history':
      return true
    case 'git':
      return true
    case 'verification':
      return parsed.action === 'list'
    case 'review':
      return parsed.action === 'get'
    case 'risk':
      return parsed.action === 'get'
    case 'fix':
      return parsed.action === 'list'
    case 'job':
    case 'session-jobs':
    case 'events':
      return true
    case 'policies':
      // /policies carries both GET list and POST create on the same path.
      return true
    case 'policy':
      return false
    default:
      return false
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parsed = parsePath(url.pathname)
    if (parsed.kind === 'not-found') {
      return sendJson(res, 404, { error: 'not found' })
    }
    // The SSE stream upgrades the connection; nothing else is dispatched.
    if (parsed.kind === 'events') {
      return handleSse(req, res)
    }
    const method = req.method ?? 'GET'
    const isRead = isReadRoute(parsed)
    // /policies serves both GET list and POST create on the same path.
    const flexibleMethod = parsed.kind === 'policies'
    if (isRead && !flexibleMethod && method !== 'GET') {
      return sendJson(res, 405, { error: 'method not allowed (expected GET)' })
    }
    if (!isRead && method !== 'POST') {
      return sendJson(res, 405, { error: 'method not allowed (expected POST)' })
    }
    let body: unknown
    if (method === 'POST') {
      body = await readJsonBody(req)
    }
    const result = await dispatch(parsed, ctx, body, url)
    sendJson(res, 200, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, message === BODY_TOO_LARGE ? 413 : 500, { error: message })
  }
}

async function dispatch(
  parsed: Exclude<Parsed, { kind: 'not-found' }>,
  ctx: Context,
  body: unknown,
  url: URL,
): Promise<unknown> {
  switch (parsed.kind) {
    case 'sessions': {
      const all = ctx.changeSessions.list()
      return { sessions: paginate(all, url), total: all.length }
    }
    case 'session': {
      const session = ctx.changeSessions.get(parsed.id)
      return session ?? { error: `unknown session "${parsed.id}"` }
    }
    case 'session-changes': {
      const all = ctx.changeSessions.changesOf(parsed.id)
      return { changes: paginate(all, url), total: all.length }
    }
    case 'session-action': {
      if (parsed.action === 'accept-all-apply') {
        return { result: await ctx.changeCenter.acceptAllAndApply(parsed.id) }
      }
      if (parsed.action === 'rollback-all') {
        return { result: await ctx.changeCenter.rollbackAll(parsed.id) }
      }
      const changes = parsed.action === 'accept-all'
        ? ctx.changeCenter.approveAll(parsed.id)
        : ctx.changeCenter.rejectAll(parsed.id)
      return { updated: changes.map(change => change.id) }
    }
    case 'changes': {
      const all = ctx.changeCenter.list()
      return { changes: paginate(all, url), total: all.length }
    }
    case 'change':
      return ctx.changeCenter.get(parsed.id) ?? { error: `unknown change "${parsed.id}"` }
    case 'change-action': {
      const change = ctx.changeCenter.get(parsed.id)
      if (change === undefined) return { error: `unknown change "${parsed.id}"` }
      switch (parsed.action) {
        case 'approve': return ctx.changeCenter.approve(parsed.id)
        case 'reject': return ctx.changeCenter.reject(parsed.id)
        case 'repend': return ctx.changeCenter.repend(parsed.id)
        case 'apply': {
          const force = url.searchParams.get('force') === '1'
          return ctx.changeCenter.apply(parsed.id, force)
        }
        case 'rollback': return ctx.changeCenter.rollback(parsed.id)
        case 'edit': {
          const { after } = (body ?? {}) as { after?: unknown }
          if (typeof after !== 'string') {
            return { error: 'edit requires a string `after` body field' }
          }
          return ctx.changeCenter.edit(parsed.id, after)
        }
      }
    }
    case 'git': {
      const session = ctx.changeSessions.get(parsed.id)
      if (session === undefined) return { error: `unknown session "${parsed.id}"` }
      switch (parsed.action) {
        case 'status': {
          const [repo, entries] = await Promise.all([
            ctx.git.repoInfo(session.workspace),
            ctx.git.status(session.workspace),
          ])
          return { repo, entries }
        }
        case 'diff': return ctx.git.diff(session.workspace)
        case 'log': return ctx.git.log(session.workspace)
      }
    }
    case 'verification': {
      const session = ctx.changeSessions.get(parsed.id)
      if (session === undefined) return { error: `unknown session "${parsed.id}"` }
      if (parsed.action === 'list') return { tasks: ctx.verification.list(parsed.id) }
      // Background job: the shell run leaves the request path immediately.
      return { job: ctx.jobs.submit(parsed.id, 'verification', signal =>
        ctx.verification.run(parsed.id, session.workspace, signal !== undefined ? { signal } : undefined)) }
    }
    case 'review': {
      if (parsed.action === 'get') return { review: ctx.aiReview.get(parsed.id) ?? null }
      const session = ctx.changeSessions.get(parsed.id)
      if (session === undefined) return { error: `unknown session "${parsed.id}"` }
      return { job: ctx.jobs.submit(parsed.id, 'review', signal =>
        ctx.aiReview.review(parsed.id, ctx.changeSessions, session.workspace, signal !== undefined ? { signal } : undefined)) }
    }
    case 'risk': {
      if (parsed.action === 'get') return { risk: ctx.risk.get(parsed.id) ?? null }
      const review = ctx.aiReview.get(parsed.id)
      return { risk: ctx.risk.analyze(parsed.id, ctx.changeCenter, review) }
    }
    case 'history': {
      const session = ctx.changeSessions.get(parsed.id)
      if (session === undefined) return { error: `unknown session "${parsed.id}"` }
      // History is keyed by the AGENT session id (change.sessionId); map the
      // change-session id to it so the timeline resolves across restarts.
      const historyKey = session.agentSessionId
      await ctx.changeHistory.load(historyKey)
      if (parsed.action === 'timeline') return ctx.changeHistory.timeline(historyKey)
      return { events: ctx.changeHistory.list(historyKey) }
    }
    case 'fix': {
      if (parsed.action === 'list') return { requests: ctx.aiFix.list(parsed.id) }
      const session = ctx.changeSessions.get(parsed.id)
      if (session === undefined) return { error: `unknown session "${parsed.id}"` }
      const { reviewId, findingId, changeId } = (body ?? {}) as { reviewId?: string; findingId?: string; changeId?: string }
      if (typeof reviewId !== 'string' || typeof findingId !== 'string' || typeof changeId !== 'string') {
        return { error: 'fix requires reviewId, findingId, and changeId' }
      }
      const review = ctx.aiReview.get(parsed.id)
      const finding = review?.findings.find(f => f.id === findingId)
      if (finding === undefined) return { error: `unknown finding "${findingId}"` }
      const change = ctx.changeCenter.get(changeId)
      if (change === undefined) return { error: `unknown change "${changeId}"` }
      return { job: ctx.jobs.submit(parsed.id, 'ai-fix', signal =>
        ctx.aiFix.fix(reviewId, finding, change, ctx.changeCenter, signal !== undefined ? { signal } : undefined)) }
    }
    case 'loop': {
      const session = ctx.changeSessions.get(parsed.id)
      if (session === undefined) return { error: `unknown session "${parsed.id}"` }
      const { maxIterations } = (body ?? {}) as { maxIterations?: number }
      return { job: ctx.jobs.submit(parsed.id, 'review-fix-loop', signal =>
        ctx.fixLoop.run(parsed.id, session.workspace, maxIterations, signal !== undefined ? { signal } : undefined)) }
    }
    case 'session-jobs':
      return { jobs: ctx.jobs.listBySession(parsed.id) }
    case 'job':
      return { job: ctx.jobs.get(parsed.id) ?? null }
    case 'job-action': {
      const job = ctx.jobs.cancel(parsed.id)
      return { job: job ?? null }
    }
    case 'policies': {
      // GET list has no body; POST create carries a policy payload.
      const policy = body as Parameters<typeof ctx.policies.save>[0] | undefined
      if (typeof policy?.id === 'string') {
        return { policies: await ctx.policies.save(policy) }
      }
      return { policies: await ctx.policies.list() }
    }
    case 'policy': {
      const policy = body as Parameters<typeof ctx.policies.save>[0]
      if (parsed.action === 'delete') return { policies: await ctx.policies.delete(parsed.id) }
      if (typeof policy?.id !== 'string' || policy.id !== parsed.id) {
        return { error: 'policy id mismatch' }
      }
      return { policies: await ctx.policies.save(policy) }
    }
  }
}

/**
 * Upgrade the connection to a Server-Sent Events stream. The forwarders
 * registered in {@link applyRoutes} write plugin events to every connected
 * client; the browser half reconnects automatically when it drops.
 */
function handleSse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write(': connected\n\n')
  sseClients.add(res)
  req.on('close', () => {
    sseClients.delete(res)
  })
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', chunk => {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(BODY_TOO_LARGE))
        return
      }
      chunks.push(chunk as Buffer)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** Slice a list with `limit`/`offset` from the query string (bounded). */
export function paginate<T>(items: T[], url: URL): T[] {
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
  return items.slice(offset, offset + limit)
}

/** Parse an integer query parameter with fallback and bounds. */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

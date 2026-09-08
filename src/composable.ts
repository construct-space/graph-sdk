/**
 * useGraph — Graph client for Construct spaces
 *
 * Usage:
 *   import { useGraph } from '@construct-space/graph'
 *   const notes = useGraph(Note)
 *   await notes.create({ content: 'hello' })
 *   const all = await notes.find()
 */

import type { ModelDef, DataRecord, GraphConfig } from './types.js'

// --- Identifier validation ---
const SAFE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/
const SAFE_ID = /^[a-zA-Z0-9_-]+$/

function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid identifier: "${name}"`)
}

function assertSafeId(id: string): void {
  if (!id || !SAFE_ID.test(id)) throw new Error(`Invalid ID: "${id}"`)
}

// --- Configuration ---
let _config: GraphConfig | null = null

/**
 * Resolve the Graph service URL. The host is the source of truth — it
 * injects `globalThis.construct.config.graphUrl` before any space mounts.
 * The SDK never hardcodes the URL: when we change endpoints (staging,
 * regional, version upgrade), we update Construct once and every space
 * picks it up on next reload. Spaces don't need to republish.
 *
 * For standalone use (tests, isolated dev) callers must pass `url` to
 * `configure()` — there's no public fallback baked into the SDK anymore.
 */
function hostGraphUrl(): string | undefined {
  if (typeof globalThis === 'undefined') return undefined
  const c = (globalThis as any).construct
  return c?.config?.graphUrl
}

function resolveUrl(explicit: string | undefined): string {
  const url = explicit || hostGraphUrl()
  if (!url) {
    throw new Error(
      "Graph URL is not configured. Inside Construct the host injects " +
        "`globalThis.construct.config.graphUrl`; for standalone use call " +
        "configure({ url, spaceId }) before defineModel/useGraph.",
    )
  }
  return url
}

/**
 * Configure the Graph client explicitly. `url` is optional inside Construct —
 * the host's injection covers it. Pass `url` for standalone use (tests,
 * isolated dev, scripts running outside the desktop app).
 */
export function configure(config: GraphConfig): void {
  const resolvedUrl = resolveUrl(config.url)
  try {
    const u = new URL(resolvedUrl)
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('URL must use http or https')
  } catch {
    throw new Error(`Invalid Graph URL: "${resolvedUrl}"`)
  }
  if (!config.spaceId) throw new Error('spaceId is required')
  _config = Object.freeze({ ...config, url: resolvedUrl })
}

// The host's currently-active space id, captured when a graph client is
// created. Returns undefined when an explicit configure() owns the spaceId
// (standalone) or no id is set yet — both fall back to per-request resolution.
function activeSpaceIdSnapshot(): string | undefined {
  if (_config) return undefined
  const c = typeof globalThis !== 'undefined' ? (globalThis as any).construct : undefined
  const id = c?.space?.id
  return typeof id === 'string' && id ? id : undefined
}

function getConfig(): GraphConfig & { url: string } {
  if (_config) return _config as GraphConfig & { url: string }

  // Auto-configure from Construct runtime — resolved fresh each call
  // so space.id changes (e.g. during preload) are picked up.
  if (typeof globalThis !== 'undefined' && (globalThis as any).construct) {
    const c = (globalThis as any).construct
    // resolveUrl will throw if neither explicit nor host-injected URL exists,
    // which is the right behaviour: a Graph call without a URL has nowhere
    // to go.
    const url = resolveUrl(undefined)
    const spaceId = c.space?.id || ''
    return {
      url,
      spaceId: spaceId || 'default',
      projectId: c.project?.id || 'default',
      companyId: c.company?.id,
      getAccessToken: c.auth?.getAccessToken,
    }
  }

  throw new Error(
    "Graph not configured. Call configure({ url, spaceId }) for standalone use, " +
      "or run inside Construct (the host injects config + auth).",
  )
}

// --- GraphQL transport ---

async function getHeaders(config: GraphConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Space-ID': config.spaceId,
    'X-Project-ID': config.projectId || 'default',
  }
  // companyId is intentionally NOT sent as a header: the graph service
  // now resolves org identity server-side from the authenticated session
  // (see infra/graph GraphQL handler). Sending X-Company-ID would be a
  // no-op at best and a security smell at worst; leaving the field in
  // GraphConfig for back-compat but it's unused.
  if (config.getAccessToken) {
    try {
      const token = await config.getAccessToken()
      if (token) {
        // Publisher API keys (csk_live_…) go in X-API-Key per the graph
        // middleware; only identity/CLI tokens (cat_…, cst_live_…, and
        // anything else the middleware falls back to accounts for) are
        // valid under Authorization: Bearer.
        if (token.startsWith('csk_live_')) headers['X-API-Key'] = token
        else headers['Authorization'] = `Bearer ${token}`
      } else {
        console.warn('[Graph] no auth token available')
      }
    } catch (e) {
      console.warn('[Graph] getAccessToken failed:', e)
    }
  } else {
    console.warn('[Graph] no getAccessToken configured')
  }
  return headers
}

/**
 * Thrown on 401 responses so spaces can render a sign-in state via
 * `instanceof` instead of grepping error messages.
 */
export class UnauthorizedError extends Error {
  override name = 'UnauthorizedError'
  status = 401 as const
  constructor(message = 'Graph: not authenticated') { super(message) }
}

interface HostGraphBridge {
  query<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    options?: { spaceId?: string; projectId?: string },
  ): Promise<T>
}

/**
 * If a Construct host has injected `globalThis.construct.graph.query`, route
 * through it. The host attaches the user's bearer server-side, so the token
 * never crosses the space sandbox boundary.
 */
function getHostBridge(): HostGraphBridge | null {
  const ctor = (globalThis as { construct?: { graph?: HostGraphBridge } }).construct
  return typeof ctor?.graph?.query === 'function' ? ctor.graph : null
}

// graphDebug gates the routine per-request trace logging. It ships quiet by
// default (these logs include query variables + row data, which is noisy and
// leaks record content to the console in production). Opt in by setting
// `globalThis.construct.config.debug = true`. Genuine errors (401, failures)
// are always logged regardless.
function graphDebug(): boolean {
  if (typeof globalThis === 'undefined') return false
  return Boolean((globalThis as { construct?: { config?: { debug?: boolean } } }).construct?.config?.debug)
}

async function gql(config: GraphConfig, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const op = query.match(/^\s*(query|mutation)/)?.[1] || 'query'
  const name = query.match(/\{\s*(\w+)/)?.[1] || 'unknown'
  if (graphDebug()) console.log(`[Graph] → ${op} ${name}`, variables)

  // Prefer host bridge when available — it handles auth + 401 typing.
  // Pass spaceId/projectId as a third argument so the host can route to the
  // correct schema when a caller has bound a non-active space via
  // useGraph(model, { spaceId }). Hosts that don't accept a third argument
  // simply ignore it, preserving the foreground-active default.
  const bridge = getHostBridge()
  if (bridge) {
    try {
      const data = await bridge.query<any>(query, variables, {
        spaceId: config.spaceId,
        projectId: config.projectId,
      })
      const rows = Array.isArray(Object.values(data || {})[0]) ? (Object.values(data)[0] as any[]).length : 1
      if (graphDebug()) console.log(`[Graph] ← ${name} (host)`, rows === 1 ? data : `${rows} rows`)
      return data
    } catch (e) {
      // Re-throw, preserving UnauthenticatedError-like errors as UnauthorizedError.
      if (e && typeof e === 'object' && (e as { name?: string }).name === 'UnauthenticatedError') {
        throw new UnauthorizedError((e as Error).message)
      }
      throw e
    }
  }

  const headers = await getHeaders(config)
  const resp = await fetch(`${config.url}/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  })

  if (resp.status === 401) {
    const text = await resp.text().catch(() => '')
    console.error(`[Graph] ← 401 ${name}`, text.slice(0, 200))
    throw new UnauthorizedError(text.slice(0, 200) || 'Graph: not authenticated')
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    console.error(`[Graph] ← ${resp.status} ${name}`, text.slice(0, 200))
    throw new Error(`Graph request failed (${resp.status}): ${text.slice(0, 200)}`)
  }

  const contentType = resp.headers.get('content-type') || ''
  if (!contentType.includes('application/json') && !contentType.includes('application/graphql')) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Unexpected response type "${contentType}": ${text.slice(0, 200)}`)
  }

  const result = await resp.json()
  if (result.errors?.length) {
    console.warn(`[Graph] ← error ${name}:`, result.errors[0].message)
    throw new Error(result.errors[0].message)
  }
  const rows = Array.isArray(Object.values(result.data || {})[0]) ? (Object.values(result.data)[0] as any[]).length : 1
  if (graphDebug()) console.log(`[Graph] ← ${name}`, rows === 1 ? result.data : `${rows} rows`)
  return result.data
}

// --- Helpers ---

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function buildFieldSelection(model: ModelDef, include?: string[]): string {
  const fields = model.fields
    .filter(f => f.type !== 'relation')
    .map(f => f.name)

  for (const f of ['id', 'created_at', 'updated_at']) {
    if (!fields.includes(f)) fields.unshift(f)
  }

  if (include) {
    for (const rel of include) {
      assertSafeName(rel)
      fields.push(`${rel} { id }`)
    }
  }

  return fields.join(' ')
}

function jsonFieldNames(model: ModelDef): Set<string> {
  return new Set(model.fields.filter(f => f.type === 'json').map(f => f.name))
}

function isSerializedJson(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function serializeJsonInput<T extends DataRecord>(input: Partial<T>, fields: Set<string>): Partial<T> {
  if (fields.size === 0) return input
  const out: Record<string, unknown> = { ...input }
  for (const name of fields) {
    if (!(name in out) || out[name] == null) continue
    const value = out[name]
    if (typeof value === 'string' && isSerializedJson(value)) continue
    out[name] = JSON.stringify(value)
  }
  return out as Partial<T>
}

function parseJsonRecord<T extends DataRecord>(record: T | null | undefined, fields: Set<string>): T | null | undefined {
  if (!record || fields.size === 0) return record
  const out: Record<string, unknown> = { ...record }
  let changed = false
  for (const name of fields) {
    const value = out[name]
    if (typeof value !== 'string') continue
    try {
      out[name] = JSON.parse(value)
      changed = true
    } catch {
      // Leave non-JSON strings as-is so legacy rows don't disappear.
    }
  }
  return (changed ? out : record) as T
}

function parseJsonRecords<T extends DataRecord>(records: T[], fields: Set<string>): T[] {
  if (fields.size === 0) return records
  return records.map(record => parseJsonRecord(record, fields) as T)
}

function parseJsonEvent<T extends DataRecord>(event: GraphChangeEvent<T>, fields: Set<string>): GraphChangeEvent<T> {
  if (fields.size === 0) return event
  return {
    ...event,
    record: parseJsonRecord(event.record, fields) || undefined,
    previousRecord: parseJsonRecord(event.previousRecord, fields) || undefined,
  }
}

export interface WhereClause {
  [field: string]: unknown | {
    $gt?: unknown; $gte?: unknown; $lt?: unknown; $lte?: unknown
    $ne?: unknown; $in?: unknown[]; $nin?: unknown[]
    $like?: string; $null?: boolean
  }
}

export interface OrderByClause {
  [field: string]: 'asc' | 'desc'
}

export interface FindOptions {
  where?: WhereClause
  orderBy?: OrderByClause
  limit?: number
  offset?: number
  include?: string[]
}

export type GraphChangeAction = 'created' | 'updated' | 'deleted'

export interface GraphChangeEvent<T extends DataRecord = DataRecord> {
  id: number
  action: GraphChangeAction
  model: string
  record?: T
  previousRecord?: T
  createdAt?: string
}

export type SubscribeHandler<T extends DataRecord = DataRecord> = (event: GraphChangeEvent<T>) => void

export interface SubscribeOptions<T extends DataRecord = DataRecord> {
  where?: WhereClause
  cursor?: number
  signal?: AbortSignal
  retryMs?: number
  onEvent: SubscribeHandler<T>
  onError?: (error: unknown) => void
}

export type GraphSubscription = () => void

function buildFilterArgs(options?: FindOptions): string {
  const args: string[] = []
  if (options?.where) args.push('$where: JSON')
  if (options?.orderBy) args.push('$orderBy: JSON')
  if (options?.limit != null) args.push('$limit: Int')
  if (options?.offset != null) args.push('$offset: Int')
  return args.length ? `(${args.join(', ')})` : ''
}

function buildQueryArgs(options?: FindOptions): string {
  const args: string[] = []
  if (options?.where) args.push('where: $where')
  if (options?.orderBy) args.push('orderBy: $orderBy')
  if (options?.limit != null) args.push('limit: $limit')
  if (options?.offset != null) args.push('offset: $offset')
  return args.length ? `(${args.join(', ')})` : ''
}

function buildVariables(options?: FindOptions): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  if (options?.where) vars.where = options.where
  if (options?.orderBy) vars.orderBy = options.orderBy
  if (options?.limit != null) vars.limit = options.limit
  if (options?.offset != null) vars.offset = options.offset
  return vars
}

interface SseMessage {
  id?: string
  event?: string
  data: string
}

function splitSseBuffer(buffer: string): [string[], string] {
  const blocks: string[] = []
  let rest = buffer

  for (;;) {
    const lf = rest.indexOf('\n\n')
    const crlf = rest.indexOf('\r\n\r\n')
    let idx = -1
    let sepLen = 0

    if (lf >= 0 && (crlf < 0 || lf < crlf)) {
      idx = lf
      sepLen = 2
    } else if (crlf >= 0) {
      idx = crlf
      sepLen = 4
    }

    if (idx < 0) return [blocks, rest]
    blocks.push(rest.slice(0, idx))
    rest = rest.slice(idx + sepLen)
  }
}

function parseSseMessage(block: string): SseMessage | null {
  const data: string[] = []
  let id: string | undefined
  let event: string | undefined

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue
    const idx = rawLine.indexOf(':')
    const field = idx >= 0 ? rawLine.slice(0, idx) : rawLine
    let value = idx >= 0 ? rawLine.slice(idx + 1) : ''
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }

  if (!id && !event && data.length === 0) return null
  return { id, event, data: data.join('\n') }
}

function normalizeChangeEvent<T extends DataRecord>(raw: any): GraphChangeEvent<T> {
  return {
    id: typeof raw?.id === 'number' ? raw.id : Number(raw?.id || 0),
    action: raw?.action,
    model: raw?.model,
    record: raw?.record as T | undefined,
    previousRecord: (raw?.previous_record ?? raw?.previousRecord) as T | undefined,
    createdAt: raw?.created_at ?? raw?.createdAt,
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError'
}

function createSubscription<T extends DataRecord>(
  modelName: string,
  getClientConfig: () => GraphConfig,
  input: SubscribeOptions<T> | SubscribeHandler<T>,
): GraphSubscription {
  const options: SubscribeOptions<T> = typeof input === 'function' ? { onEvent: input } : input
  let cursor = options.cursor ?? 0
  let stopped = false
  let controller: AbortController | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let removeAbortListener = (): void => {}

  const stop = (): void => {
    stopped = true
    removeAbortListener()
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    controller?.abort()
    controller = null
  }

  if (options.signal) {
    if (options.signal.aborted) {
      stop()
    } else {
      options.signal.addEventListener('abort', stop, { once: true })
      removeAbortListener = () => options.signal?.removeEventListener('abort', stop)
    }
  }

  const scheduleReconnect = (): void => {
    if (stopped) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void connect()
    }, options.retryMs ?? 1000)
  }

  const handleMessage = (message: SseMessage): void => {
    if (message.id) cursor = Number(message.id) || cursor
    if (message.event !== 'graph_event' || !message.data) return

    const event = normalizeChangeEvent<T>(JSON.parse(message.data))
    if (event.id) cursor = event.id
    options.onEvent(event)
  }

  const connect = async (): Promise<void> => {
    if (stopped) return
    controller = new AbortController()

    try {
      const config = getClientConfig()
      const headers = await getHeaders(config)
      delete headers['Content-Type']

      const params = new URLSearchParams({ model: modelName })
      if (cursor > 0) params.set('cursor', String(cursor))
      if (options.where && Object.keys(options.where).length > 0) {
        params.set('where', JSON.stringify(options.where))
      }

      const resp = await fetch(`${resolveUrl(config.url)}/realtime/stream?${params.toString()}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Graph realtime failed (${resp.status}): ${text.slice(0, 200)}`)
      }
      if (!resp.body) throw new Error('Graph realtime stream is not readable in this environment')

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const [blocks, rest] = splitSseBuffer(buffer)
        buffer = rest
        for (const block of blocks) {
          const message = parseSseMessage(block)
          if (message) handleMessage(message)
        }
      }

      const tail = buffer + decoder.decode()
      const message = parseSseMessage(tail)
      if (message) handleMessage(message)
      scheduleReconnect()
    } catch (error) {
      if (stopped || isAbortError(error)) return
      options.onError?.(error)
      scheduleReconnect()
    }
  }

  void connect()
  return stop
}

export interface GraphListOptions<T extends DataRecord = DataRecord> extends FindOptions {
  realtime?: boolean
  cursor?: number
  signal?: AbortSignal
  retryMs?: number
  onEvent?: SubscribeHandler<T>
  onError?: (error: unknown) => void
}

export interface GraphList<T extends DataRecord = DataRecord> {
  items: T[]
  loading: boolean
  error: unknown | null
  load(options?: FindOptions): Promise<T[]>
  refresh(): Promise<T[]>
  create(input: Partial<T>): Promise<T>
  update(id: string, input: Partial<T>): Promise<T>
  remove(id: string): Promise<boolean>
  applyEvent(event: GraphChangeEvent<T>): void
  start(): GraphSubscription
  stop(): void
}

function findOptionsFrom(options: FindOptions): FindOptions {
  return {
    where: options.where,
    orderBy: options.orderBy,
    limit: options.limit,
    offset: options.offset,
    include: options.include,
  }
}

function recordMatchesWhere(record: DataRecord | undefined, where?: WhereClause): boolean {
  if (!where || Object.keys(where).length === 0) return true
  if (!record) return false

  for (const [field, expected] of Object.entries(where)) {
    const actual = record[field]
    if (!valueMatchesWhere(actual, expected)) return false
  }
  return true
}

function valueMatchesWhere(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    for (const [op, value] of Object.entries(expected as Record<string, unknown>)) {
      switch (op) {
        case '$gt':
          if (!(actual != null && actual > value!)) return false
          break
        case '$gte':
          if (!(actual != null && actual >= value!)) return false
          break
        case '$lt':
          if (!(actual != null && actual < value!)) return false
          break
        case '$lte':
          if (!(actual != null && actual <= value!)) return false
          break
        case '$ne':
          if (actual === value) return false
          break
        case '$in':
          if (!Array.isArray(value) || !value.includes(actual)) return false
          break
        case '$nin':
          if (Array.isArray(value) && value.includes(actual)) return false
          break
        case '$like':
          if (typeof actual !== 'string' || typeof value !== 'string' || !actual.includes(value.replace(/%/g, ''))) return false
          break
        case '$null':
          if ((actual == null) !== Boolean(value)) return false
          break
        default:
          return false
      }
    }
    return true
  }
  return actual === expected
}

function sortGraphList<T extends DataRecord>(items: T[], options: FindOptions): void {
  const orderBy = options.orderBy || { created_at: 'desc' as const }
  const entries = Object.entries(orderBy)
  if (entries.length === 0) return

  items.sort((a, b) => {
    for (const [field, dir] of entries) {
      const av = a[field]
      const bv = b[field]
      if (av === bv) continue
      const result = av == null ? -1 : bv == null ? 1 : av < bv ? -1 : 1
      return dir === 'desc' ? -result : result
    }
    return 0
  })
}

function clampGraphList<T extends DataRecord>(items: T[], options: FindOptions): void {
  if (options.limit != null && options.limit >= 0 && items.length > options.limit) {
    items.splice(options.limit)
  }
}

// --- useGraph ---

export interface GraphClient<T extends DataRecord = DataRecord> {
  /** Find multiple records */
  find(options?: FindOptions): Promise<T[]>
  /** Find one record by ID */
  findOne(id: string): Promise<T | null>
  /** Create a record */
  create(input: Partial<T>): Promise<T>
  /** Update a record */
  update(id: string, input: Partial<T>): Promise<T>
  /** Delete a record */
  remove(id: string): Promise<boolean>
  /** Count records */
  count(options?: FindOptions): Promise<number>
  /** Subscribe to realtime changes for this model */
  subscribe(options: SubscribeOptions<T> | SubscribeHandler<T>): GraphSubscription
  /** Raw GraphQL query */
  query(query: string, variables?: Record<string, unknown>): Promise<any>
  /** Raw GraphQL mutation */
  mutate(mutation: string, variables?: Record<string, unknown>): Promise<any>
}

export function createGraphList<T extends DataRecord = DataRecord>(
  client: GraphClient<T>,
  options: GraphListOptions<T> = {},
): GraphList<T> {
  let currentOptions = findOptionsFrom(options)
  let stopSubscription: GraphSubscription | null = null

  const upsert = (record: T): void => {
    const idx = list.items.findIndex(item => item.id === record.id)
    if (idx >= 0) list.items.splice(idx, 1, record)
    else list.items.push(record)
    sortGraphList(list.items, currentOptions)
    clampGraphList(list.items, currentOptions)
  }

  const removeLocal = (id: string | undefined): void => {
    if (!id) return
    const idx = list.items.findIndex(item => item.id === id)
    if (idx >= 0) list.items.splice(idx, 1)
  }

  const list: GraphList<T> = {
    items: [],
    loading: false,
    error: null,

    async load(nextOptions?: FindOptions): Promise<T[]> {
      if (nextOptions) currentOptions = { ...currentOptions, ...nextOptions }
      list.loading = true
      list.error = null
      try {
        const rows = await client.find(currentOptions)
        list.items.splice(0, list.items.length, ...rows)
        return list.items
      } catch (error) {
        list.error = error
        throw error
      } finally {
        list.loading = false
      }
    },

    refresh(): Promise<T[]> {
      return list.load()
    },

    async create(input: Partial<T>): Promise<T> {
      const record = await client.create(input)
      if (recordMatchesWhere(record, currentOptions.where)) upsert(record)
      return record
    },

    async update(id: string, input: Partial<T>): Promise<T> {
      const record = await client.update(id, input)
      if (recordMatchesWhere(record, currentOptions.where)) upsert(record)
      else removeLocal(id)
      return record
    },

    async remove(id: string): Promise<boolean> {
      const ok = await client.remove(id)
      if (ok) removeLocal(id)
      return ok
    },

    applyEvent(event: GraphChangeEvent<T>): void {
      const record = event.record
      const previousRecord = event.previousRecord
      if (event.action === 'deleted') {
        removeLocal(record?.id || previousRecord?.id)
        options.onEvent?.(event)
        return
      }
      if (record && recordMatchesWhere(record, currentOptions.where)) upsert(record)
      else removeLocal(record?.id || previousRecord?.id)
      options.onEvent?.(event)
    },

    start(): GraphSubscription {
      if (stopSubscription) return list.stop
      stopSubscription = client.subscribe({
        where: currentOptions.where,
        cursor: options.cursor,
        signal: options.signal,
        retryMs: options.retryMs,
        onEvent: list.applyEvent,
        onError: options.onError,
      })
      return list.stop
    },

    stop(): void {
      stopSubscription?.()
      stopSubscription = null
    },
  }

  if (options.realtime) list.start()
  return list
}

/**
 * useGraph — Graph client for a model. Auto-configures from Construct runtime.
 *
 * Usage:
 *   const notes = useGraph(Note)
 *   await notes.create({ content: 'hello', color: 'yellow' })
 *   const all = await notes.find()
 *   await notes.update(id, { content: 'updated' })
 *   await notes.remove(id)
 *   const raw = await notes.query('{ notes { id content } }')
 */
export function useGraph<T extends DataRecord = DataRecord>(model: ModelDef, options?: { spaceId?: string }): GraphClient<T> {
  const table = model.name
  assertSafeName(table)
  const jsonFields = jsonFieldNames(model)

  // Bind the space at creation time. If the caller passed one, use it.
  // Otherwise SNAPSHOT the host's active space id now (this client is created
  // inside the owning space's setup, when its id is active) instead of reading
  // the mutable global lazily on every request. Lazy resolution let a later
  // active space (e.g. after navigation, or a background automation) steer this
  // client's queries into the wrong Postgres schema -> "relation ... does not
  // exist". Falls back to lazy only when no id is resolvable yet.
  const boundSpaceId = options?.spaceId ?? activeSpaceIdSnapshot()

  function cfg(): GraphConfig {
    const base = _config || getConfig()
    if (boundSpaceId) {
      return { ...base, spaceId: boundSpaceId }
    }
    return base
  }

  return {
    async find(options?: FindOptions): Promise<T[]> {
      const fields = buildFieldSelection(model, options?.include)
      const filterDef = buildFilterArgs(options)
      const queryArgs = buildQueryArgs(options)
      const vars = buildVariables(options)
      const q = `query${filterDef} { ${table}s${queryArgs} { ${fields} } }`
      const data = await gql(cfg(), q, vars)
      return parseJsonRecords((data?.[`${table}s`] || []) as T[], jsonFields)
    },

    async findOne(id: string): Promise<T | null> {
      assertSafeId(id)
      const fields = buildFieldSelection(model)
      const q = `query($id: ID!) { ${table}(id: $id) { ${fields} } }`
      const data = await gql(cfg(), q, { id })
      return (parseJsonRecord(data?.[table] as T | undefined, jsonFields) as T) || null
    },

    async create(input: Partial<T>): Promise<T> {
      const name = `create${capitalize(table)}`
      const fields = buildFieldSelection(model)
      const q = `mutation($input: JSON!) { ${name}(input: $input) { ${fields} } }`
      const data = await gql(cfg(), q, { input: serializeJsonInput(input, jsonFields) })
      return parseJsonRecord(data?.[name] as T | undefined, jsonFields) as T
    },

    async update(id: string, input: Partial<T>): Promise<T> {
      assertSafeId(id)
      const name = `update${capitalize(table)}`
      const fields = buildFieldSelection(model)
      const q = `mutation($id: ID!, $input: JSON!) { ${name}(id: $id, input: $input) { ${fields} } }`
      const data = await gql(cfg(), q, { id, input: serializeJsonInput(input, jsonFields) })
      return parseJsonRecord(data?.[name] as T | undefined, jsonFields) as T
    },

    async remove(id: string): Promise<boolean> {
      assertSafeId(id)
      const name = `delete${capitalize(table)}`
      const q = `mutation($id: ID!) { ${name}(id: $id) }`
      const data = await gql(cfg(), q, { id })
      return !!data?.[name]
    },

    async count(options?: FindOptions): Promise<number> {
      const filterDef = buildFilterArgs(options)
      const queryArgs = buildQueryArgs(options)
      const vars = buildVariables(options)
      const q = `query${filterDef} { ${table}sCount${queryArgs} }`
      const data = await gql(cfg(), q, vars)
      return (data?.[`${table}sCount`] as number) || 0
    },

    subscribe(options: SubscribeOptions<T> | SubscribeHandler<T>): GraphSubscription {
      const subscriptionOptions: SubscribeOptions<T> = typeof options === 'function' ? { onEvent: options } : options
      return createSubscription<T>(table, cfg, {
        ...subscriptionOptions,
        onEvent(event) {
          subscriptionOptions.onEvent(parseJsonEvent(event, jsonFields))
        },
      })
    },

    async query(query: string, variables?: Record<string, unknown>): Promise<any> {
      return gql(cfg(), query, variables || {})
    },

    async mutate(mutation: string, variables?: Record<string, unknown>): Promise<any> {
      return gql(cfg(), mutation, variables || {})
    },
  }
}

export function useGraphList<T extends DataRecord = DataRecord>(
  model: ModelDef,
  options: GraphListOptions<T> & { spaceId?: string } = {},
): GraphList<T> {
  const { spaceId, ...listOptions } = options
  return createGraphList(useGraph<T>(model, { spaceId }), listOptions)
}

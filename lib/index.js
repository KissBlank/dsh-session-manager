/**
 * Session Manager — the Host half.
 *
 * DSH's archive action only hides a Session. Everything the Session owns stays
 * behind: the JSONL log under `<DSH_HOME>/sessions/<project>/<id>/`, its entry
 * in the Workspace record, the archive and pin ids in the Workspace domain, and
 * the projection cache under `<DSH_HOME>/storages/session_projcache/`. This
 * plugin finishes that job for exactly one Session at a time:
 *
 *   1. stop whatever still runs for it (`workspace/session-stop`, the seam the
 *      agent and job packages listen on) and let a draining turn settle,
 *   2. release the in-memory Session so the Host stops publishing it,
 *   3. drop its membership from every Workspace plus its archive and pin ids,
 *   4. delete its Session directories (the log is the single source of truth),
 *   5. delete its projection-cache record.
 *
 * The browser half asks for this over one loopback route on the Host's own
 * webServer, behind the same request fence the shipped `/api` uses — this route
 * can delete user data, so it answers POST only, same-origin only.
 */

import { readdir, rm, rmdir, stat as statPath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export const name = 'session-manager'

export const inject = ['webServer']

/** Delete one Session; the browser half calls this for every deletion. */
const ROUTE = '/session-manager/api/purge'
/** Read-only metadata the console needs and the browser list does not carry. */
const INVENTORY_ROUTE = '/session-manager/api/inventory'
/** Drop projection-cache records whose Session no longer exists. */
const CACHE_UPKEEP_ROUTE = '/session-manager/api/maintenance/cache'
/** Drop project folders under the sessions root that hold no Session. */
const DIRECTORY_UPKEEP_ROUTE = '/session-manager/api/maintenance/directories'
/** `session-` followed by an opaque id; the shape also rules out path traversal. */
const SESSION_ID = /^session-[A-Za-z0-9-]{4,}$/
const MAX_BODY_BYTES = 4096
const IDLE_TIMEOUT_MS = 3000
const IDLE_POLL_MS = 120

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0:0:0:0:0:0:0:1'])

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (request, response) => handlePurge(ctx, request, response),
    }),
    'session-manager: purge route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: INVENTORY_ROUTE,
      handler: (request, response) => handleInventory(ctx, request, response),
    }),
    'session-manager: inventory route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: CACHE_UPKEEP_ROUTE,
      handler: (request, response) => handleUpkeep(ctx, request, response, 'cache'),
    }),
    'session-manager: cache upkeep route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: DIRECTORY_UPKEEP_ROUTE,
      handler: (request, response) => handleUpkeep(ctx, request, response, 'directories'),
    }),
    'session-manager: directory upkeep route',
  )
}

/** Answer the console's read-only request. Always writes a response. */
async function handleInventory(host, request, response) {
  if (request.method !== 'GET') {
    sendJson(response, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'GET' })
    return
  }
  const refusal = requestRefusal(host, request)
  if (refusal !== undefined) {
    sendJson(response, refusal, { ok: false, error: 'refused' })
    return
  }
  try {
    sendJson(response, 200, { ok: true, sessions: await inventory(host) })
  } catch (error) {
    sendJson(response, 500, { ok: false, error: 'inventory-failed', message: messageOf(error) })
  }
}

/**
 * Session headers across the live and persisted corpora.
 *
 * Only fields the browser Session list lacks are returned: the console sorts by
 * creation time, which the list snapshot does not carry. A conflicting live and
 * persisted pair makes `listSessions` throw; that is reported as an empty list
 * so the console still opens (it can sort by activity instead).
 */
async function inventory(host) {
  const query = host.get('sessionQuery')
  if (query === undefined || typeof query.listSessions !== 'function') return []
  const records = await query.listSessions()
  const sessions = []
  for (const record of Array.isArray(records) ? records : []) {
    const header = record?.header
    if (header === undefined || header === null || typeof header.id !== 'string') continue
    sessions.push({
      id: header.id,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
      parentId: typeof header.parentSession === 'string' ? header.parentSession : null,
      origin: typeof header.origin === 'string' ? header.origin : null,
    })
  }
  return sessions
}

/**
 * Housekeeping: the debris a deletion does not own.
 *
 * Deleting a Session removes exactly that Session's record and folder. Anything
 * left behind by an older deletion — cache records whose log is already gone, a
 * project folder that no longer holds a Session — is invisible debris. These two
 * routes clear it, and both are deliberately conservative: a live Session (in
 * memory, or on disk) is never touched, and nothing outside the sessions root is
 * removed.
 */
async function handleUpkeep(host, request, response, kind) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' })
    return
  }
  const refusal = requestRefusal(host, request)
  if (refusal !== undefined) {
    sendJson(response, refusal, { ok: false, error: 'refused' })
    return
  }
  try {
    const payload = kind === 'cache' ? await pruneOrphanProjections(host) : await pruneEmptyProjects(host)
    sendJson(response, 200, { ok: true, kind, ...payload })
  } catch (error) {
    sendJson(response, 500, { ok: false, error: 'upkeep-failed', kind, message: messageOf(error) })
  }
}

/**
 * Every Session the Host still knows about: the live store plus the logs on disk.
 *
 * An id in either place is protected. Consulting both is what makes the sweep
 * safe against the two windows a single source would miss — a Session that was
 * created but not yet flushed, and one whose log exists but is not loaded.
 */
async function knownSessionIds(host) {
  const ids = new Set()
  const store = host.get('sessions')?.store
  if (store instanceof Map) {
    for (const id of store.keys()) if (typeof id === 'string') ids.add(id)
  }
  const root = sessionsRoot(host)
  if (root === undefined) return ids
  for (const project of await projectDirectories(root)) {
    let entries
    try {
      entries = await readdir(project, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) if (entry.isDirectory()) ids.add(entry.name)
  }
  return ids
}

/** Root of the Session logs, as the persistence service reports it. */
function sessionsRoot(host) {
  const root = host.get('sessionPersistence')?.root
  return typeof root === 'string' && root.length > 0 ? root : undefined
}

/** Resolve every child directory of the sessions root, refusing escapes. */
async function projectDirectories(root) {
  const resolvedRoot = resolve(root)
  let entries
  try {
    entries = await readdir(resolvedRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const projects = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = resolve(join(resolvedRoot, entry.name))
    if (!candidate.startsWith(resolvedRoot + sep)) continue
    projects.push(candidate)
  }
  return projects
}

/**
 * Delete projection-cache records whose Session is gone.
 *
 * The domain table is the only writer that keeps memory and disk in step, so the
 * sweep goes through `table.delete` instead of unlinking files behind its back.
 * The record's size is measured first, while the file still exists, so the
 * console can report what left the disk.
 */
async function pruneOrphanProjections(host) {
  const known = await knownSessionIds(host)
  const table = host.get('sessionProjectionCache')?.table
  if (table === undefined || typeof table.keys !== 'function' || typeof table.delete !== 'function') {
    return { scanned: 0, removed: 0, freedBytes: 0, skipped: 'projection-cache-unavailable' }
  }
  let ids
  try {
    ids = [...table.keys()]
  } catch {
    return { scanned: 0, removed: 0, freedBytes: 0, skipped: 'projection-cache-unreadable' }
  }
  const directory = projectionCacheDirectory(host)
  let removed = 0
  let freedBytes = 0
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || known.has(id)) continue
    const bytes = directory === undefined ? 0 : await fileSize(join(directory, `${id}.json`))
    let gone = false
    try {
      gone = await table.delete(id)
    } catch {
      gone = false
    }
    if (gone !== false) {
      removed += 1
      freedBytes += bytes
    }
  }
  return { scanned: ids.length, removed, freedBytes }
}

/**
 * `<DSH_HOME>/storages/session_projcache/sessions`, derived from the sessions
 * root so the Host's own DSH_HOME choice is respected. Only used to measure a
 * record before it is deleted; a wrong guess costs a byte count, not a file.
 */
function projectionCacheDirectory(host) {
  const root = sessionsRoot(host)
  if (root === undefined) return undefined
  return join(resolve(root, '..'), 'storages', 'session_projcache', 'sessions')
}

/** Delete project folders that hold no Session at all. */
async function pruneEmptyProjects(host) {
  const root = sessionsRoot(host)
  if (root === undefined) return { scanned: 0, removed: 0, names: [], skipped: 'sessions-root-unavailable' }
  const projects = await projectDirectories(root)
  const names = []
  for (const project of projects) {
    let entries
    try {
      entries = await readdir(project, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.length > 0) continue
    try {
      await rmdir(project)
      names.push(project)
    } catch {
      // Not empty after all, or a permission problem: leave it.
    }
  }
  return { scanned: projects.length, removed: names.length, names }
}

async function fileSize(path) {
  try {
    const info = await statPath(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

/** Answer one HTTP request. Always writes a response; never throws at the caller. */
async function handlePurge(host, request, response) {  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: 'method-not-allowed' }, { allow: 'POST' })
    return
  }
  const refusal = requestRefusal(host, request)
  if (refusal !== undefined) {
    sendJson(response, refusal, { ok: false, error: 'refused' })
    return
  }
  let body
  try {
    body = await readJsonBody(request, MAX_BODY_BYTES)
  } catch (error) {
    sendJson(response, 400, { ok: false, error: 'invalid-request', message: messageOf(error) })
    return
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!SESSION_ID.test(sessionId)) {
    sendJson(response, 400, { ok: false, error: 'invalid-session-id', message: `"${sessionId}" is not a Session id` })
    return
  }
  try {
    sendJson(response, 200, { ok: true, ...await purgeSession(host, sessionId) })
  } catch (error) {
    sendJson(response, 500, { ok: false, error: 'purge-failed', message: messageOf(error) })
  }
}

/**
 * Delete every trace of one Session.
 *
 * Order matters: a Session that is still live can append to its log and its
 * projection cache, so it is stopped and released before the files go away.
 * Membership and archive/pin ids are dropped before the files because those
 * writes are what the browser watches for — the row disappears even if a later
 * step fails.
 */
async function purgeSession(host, sessionId) {
  const registry = host.get('workspaceRegistry')
  const persistence = host.get('sessionPersistence')

  const stopped = await stopActivity(registry, sessionId)
  await waitForIdle(host, sessionId, IDLE_TIMEOUT_MS)
  const released = releaseLiveSession(host, sessionId)

  let workspaces = 0
  if (registry !== undefined) {
    for (const workspace of registry.list()) {
      try {
        // Idempotent, and a Workspace that never listed this Session writes nothing.
        await workspace.detachSession(sessionId)
        workspaces += 1
      } catch {
        // One unwritable Workspace must not block the deletion.
      }
    }
    await settle(() => registry.unarchiveSession(sessionId))
    await settle(() => registry.unpinSession(sessionId))
  }

  const root = typeof persistence?.root === 'string' ? persistence.root : undefined
  const directories = root === undefined ? [] : await findSessionDirectories(root, sessionId)
  for (const directory of directories) await rm(directory, { recursive: true, force: true })

  const cacheRemoved = await forgetProjection(host, sessionId)

  return { sessionId, stopped, released, workspaces, directories, cacheRemoved }
}

/** Ask every `workspace/session-stop` listener to cancel this Session's work. */
async function stopActivity(registry, sessionId) {
  if (registry === undefined || typeof registry.stopSessionActivity !== 'function') return false
  try {
    await registry.stopSessionActivity(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Wait until no listener reports activity for the Session.
 *
 * The registry answers the same `workspace/session-activity` waterfall when it
 * gates archiving, so this is the Host's own definition of "still running". A
 * turn that will not settle inside the timeout is not waited on forever: the
 * deletion proceeds and the turn's writer loses its Session.
 */
async function waitForIdle(host, sessionId, timeoutMs) {
  if (typeof host.waterfall !== 'function') return
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let activity
    try {
      activity = await host.waterfall('workspace/session-activity', { sessionId }, () => [])
    } catch {
      return
    }
    if (!Array.isArray(activity) || activity.length === 0) return
    if (Date.now() >= deadline) return
    await new Promise((resolveWait) => setTimeout(resolveWait, IDLE_POLL_MS))
  }
}

/**
 * Remove the Session from the in-memory store.
 *
 * `ctx.sessions` has no public removal method: a Session lives exactly as long
 * as the effect that entered it, and DSH hands that disposer to the caller. The
 * store keeps the same closure on its entry, so calling it here is the one
 * removal path the store itself offers. A Session that is not live (the common
 * case for an older log) needs nothing.
 *
 * Removing the entry is what stops the Host from listing a deleted Session as
 * `live` and re-announcing it to every browser after the files are gone.
 */
function releaseLiveSession(host, sessionId) {
  const sessions = host.get('sessions')
  const store = sessions?.store
  if (!(store instanceof Map)) return false
  const entry = store.get(sessionId)
  if (entry === undefined || typeof entry.detach !== 'function') return false
  try {
    entry.detach()
    return true
  } catch {
    return false
  }
}

/**
 * Find every directory that holds this Session's log.
 *
 * `<root>/<projectKey(cwd)>/<sessionId>/`, where the project key is derived from
 * a header field. Rather than re-deriving that encoding (and silently breaking
 * when it changes), the root is scanned for a child directory named after the
 * Session — the directory name is the plain id because ids only use safe
 * characters. The resolved path is re-checked against the root before any
 * caller removes it.
 */
async function findSessionDirectories(root, sessionId) {
  const resolvedRoot = resolve(root)
  let entries
  try {
    entries = await readdir(resolvedRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = resolve(join(resolvedRoot, entry.name, sessionId))
    if (!candidate.startsWith(resolvedRoot + sep)) continue
    try {
      if ((await statPath(candidate)).isDirectory()) found.push(candidate)
    } catch {
      // Not this project, or not a directory.
    }
  }
  return found
}

/** Delete the projection-cache record; the cache has no public delete either. */
async function forgetProjection(host, sessionId) {
  const table = host.get('sessionProjectionCache')?.table
  if (table === undefined || typeof table.delete !== 'function') return false
  try {
    await table.delete(sessionId)
    return true
  } catch {
    return false
  }
}

/** Run one optional cleanup step; report whether it succeeded. */
async function settle(operation) {
  try {
    await operation()
    return true
  } catch {
    return false
  }
}

/**
 * The Host's own admission fence, plus a same-origin check.
 *
 * Mirrors the fence the shipped API routes use: ask the connection service
 * first (it knows about trusted LAN hosts and desktop proxy traffic), then
 * refuse a browser-marked cross-site request, then require the Origin — when
 * present — to name this same authority. The desktop shell strips Origin, so a
 * missing Origin is not treated as hostile.
 */
function requestRefusal(host, request) {
  const connection = host.get('connection')
  const gate = connection?.requestRejection
  if (typeof gate === 'function') {
    try {
      const status = gate.call(connection, request)
      if (typeof status === 'number') return status
    } catch {
      return 403
    }
  }
  return sameOrigin(host, request) ? undefined : 403
}

function sameOrigin(host, request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const header = request.headers.host
  if (typeof header !== 'string' || header.length === 0) return false
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.host === header) return true
  // Chrome omits the default port from loopback Origins; the names still match.
  const originName = hostName(url.host)
  const headerName = hostName(header)
  if (originName === undefined || headerName === undefined || originName !== headerName) return false
  return url.port === '' && (LOOPBACK.has(headerName) || trustedAuthority(host, header))
}

/** The host part of an `authority` pair, keeping IPv6 brackets. */
function hostName(authority) {
  const value = authority.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end < 0 ? undefined : value.slice(0, end + 1)
  }
  const colon = value.lastIndexOf(':')
  return colon < 0 ? value : value.slice(0, colon)
}

/** Whether a deployment declared this authority as trusted (LAN, reverse proxy). */
function trustedAuthority(host, authority) {
  const trusted = host.get('connection')?.trustedHosts
  if (!Array.isArray(trusted)) return false
  const value = authority.trim().toLowerCase()
  const name = hostName(value)
  return trusted.some((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') return false
    const declared = entry.trim().toLowerCase()
    return declared === value || (name !== undefined && hostName(declared) === name)
  })
}

async function readJsonBody(request, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(JSON.stringify(payload))
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

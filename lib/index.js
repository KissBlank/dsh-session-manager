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
 *      together with every sub-agent Session it spawned — those logs live in
 *      their own directories and the sidebar never shows them, so leaving them
 *      behind would silently keep a copy of the deleted work,
 *   5. delete its projection-cache record.
 *
 * The browser half asks for this over one loopback route on the Host's own
 * webServer, behind the same request fence the shipped `/api` uses — this route
 * can delete user data, so it answers POST only, same-origin only.
 */

import { readdir, readFile as readTextFile, rm, rmdir, stat as statPath, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

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
/** Drop storage backups that still name Sessions which no longer exist. */
const BACKUP_UPKEEP_ROUTE = '/session-manager/api/maintenance/backups'
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
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: BACKUP_UPKEEP_ROUTE,
      handler: (request, response) => handleUpkeep(ctx, request, response, 'backups'),
    }),
    'session-manager: backup upkeep route',
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
 * persisted pair makes `listSessions` throw; the persistence listing is then used
 * on its own, so the console still opens with every log on disk. When neither
 * source answers this throws, because an empty list would look like an empty
 * corpus.
 */
async function inventory(host) {
  const records = await sessionHeaders(host)
  if (records === null) throw new Error('Session headers are unavailable')
  const sessions = []
  for (const record of records) {
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
    const payload = kind === 'cache'
      ? await pruneOrphanProjections(host)
      : kind === 'directories'
        ? await pruneEmptyProjects(host)
        : await pruneStaleBackups(host)
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
 *
 * `resolved` says whether every source could actually be read. A sweep must not
 * treat an unreadable sessions root as an empty one: doing so would mark every
 * Session on disk as deleted and let the cleanup paths erase their records.
 */
async function knownSessionIds(host) {
  const ids = new Set()
  const store = host.get('sessions')?.store
  if (store instanceof Map) {
    for (const id of store.keys()) if (typeof id === 'string') ids.add(id)
  }
  const root = sessionsRoot(host)
  if (root === undefined) return { ids, resolved: false }
  const scan = await projectDirectories(root)
  let resolved = scan.resolved
  for (const project of scan.directories) {
    let entries
    try {
      entries = await readdir(project, { withFileTypes: true })
    } catch {
      // A project that cannot be listed may still hold live Sessions; the id
      // set is incomplete, so callers that delete anything must refuse to act.
      resolved = false
      continue
    }
    for (const entry of entries) if (entry.isDirectory()) ids.add(entry.name)
  }
  return { ids, resolved }
}

/** Root of the Session logs, as the persistence service reports it. */
function sessionsRoot(host) {
  const root = host.get('sessionPersistence')?.root
  return typeof root === 'string' && root.length > 0 ? root : undefined
}

/**
 * Resolve every child directory of the sessions root, refusing escapes.
 *
 * `resolved` distinguishes "the root holds no project" from "the root could not
 * be listed". The two look identical as an empty array but mean opposite
 * things to a sweep that is about to delete records for unknown ids.
 */
async function projectDirectories(root) {
  const resolvedRoot = resolve(root)
  let entries
  try {
    entries = await readdir(resolvedRoot, { withFileTypes: true })
  } catch {
    return { directories: [], resolved: false }
  }
  const projects = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = resolve(join(resolvedRoot, entry.name))
    if (!candidate.startsWith(resolvedRoot + sep)) continue
    projects.push(candidate)
  }
  return { directories: projects, resolved: true }
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
  // Without the sessions root, the known set would hold only the live store and
  // every log on disk would look deleted — refuse instead of guessing.
  if (sessionsRoot(host) === undefined) {
    return { scanned: 0, removed: 0, freedBytes: 0, skipped: 'sessions-root-unavailable' }
  }
  const known = await knownSessionIds(host)
  if (!known.resolved) {
    return { scanned: 0, removed: 0, freedBytes: 0, skipped: 'sessions-unreadable' }
  }
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
    if (typeof id !== 'string' || id === '' || known.ids.has(id)) continue
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
  const scan = await projectDirectories(root)
  if (!scan.resolved) return { scanned: 0, removed: 0, names: [], skipped: 'sessions-unreadable' }
  const projects = scan.directories
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

/**
 * Scrub Session ids out of the storage backups the Host keeps for inspection.
 *
 * When a storage record cannot be read the Host moves the document aside as
 * `<name>.json.bak-<epoch>` and starts over; those files keep naming Sessions
 * that may be deleted later, which is exactly the kind of trace a "delete for
 * good" promise cannot leave behind. Only ids the Host no longer knows are
 * removed: a live Session's id stays, so a backup still describes the corpus it
 * was taken from.
 *
 * The registry's own archive and pin sets are swept first, through the API
 * rather than by editing `workspace.json`: those ids belong to a Session that
 * no longer exists, so `unarchiveSession`/`unpinSession` drop them and write the
 * live document back. A `.bak-*` file is only edited when the id is gone
 * everywhere.
 */
async function pruneStaleBackups(host) {
  // Resolve everything that can refuse before the registry is touched: a sweep
  // that reports "skipped" after rewriting the archive and pin sets would be
  // lying about what it changed.
  if (sessionsRoot(host) === undefined) {
    return { scanned: 0, removed: 0, freedBytes: 0, staleIds: 0, skipped: 'sessions-root-unavailable' }
  }
  const directory = storagesDirectory(host)
  if (directory === undefined) {
    return { scanned: 0, removed: 0, freedBytes: 0, staleIds: 0, skipped: 'storages-unavailable' }
  }
  const known = await knownSessionIds(host)
  if (!known.resolved) {
    return { scanned: 0, removed: 0, freedBytes: 0, staleIds: 0, skipped: 'sessions-unreadable' }
  }
  // Read the directory before the registry is touched: a directory that cannot
  // be listed must produce a skipped answer without any side effect.
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return { scanned: 0, removed: 0, freedBytes: 0, staleIds: 0, skipped: 'storages-unreadable' }
  }
  const registry = host.get('workspaceRegistry')
  // One id can sit in both sets; count the Session once, not the writes.
  const candidates = new Set()
  if (registry !== undefined) {
    // Both getters go through the registry's `requireState()` and throw while it
    // is still starting; reading them through `readSet` keeps the file sweep —
    // which is the actual job — from failing over a set nobody can read yet.
    for (const id of (await readSet(() => registry.archivedSessionIds)) ?? []) {
      if (!known.ids.has(id)) candidates.add(id)
    }
    for (const id of (await readSet(() => registry.pinnedSessionIds)) ?? []) {
      if (!known.ids.has(id)) candidates.add(id)
    }
  }
  let staleIds = 0
  for (const id of candidates) {
    const unarchived = await settle(() => registry.unarchiveSession(id))
    const unpinned = await settle(() => registry.unpinSession(id))
    if (unarchived || unpinned) staleIds += 1
  }
  let scanned = 0
  let removed = 0
  let freedBytes = 0
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isFile()) {
      // A whole-unit backup: the document still names Sessions inside its arrays.
      if (!entry.name.includes('.bak-')) continue
      scanned += 1
      const before = await fileSize(path)
      let text
      try {
        text = await readTextFile(path)
      } catch {
        continue
      }
      let document
      try {
        document = JSON.parse(text)
      } catch {
        continue
      }
      const scrubbed = scrubSessionIds(document, known.ids)
      if (scrubbed === 0) continue
      const next = `${JSON.stringify(document, null, 2)}\n`
      try {
        await writeFile(path, next, 'utf8')
      } catch {
        continue
      }
      removed += 1
      const after = await fileSize(path)
      freedBytes += Math.max(0, before - after)
      continue
    }
    if (!entry.isDirectory()) continue
    // Per-record backups live under `<storages>/<unit>/<table>/<id>.json.bak.<stamp>`.
    // Their file name carries the Session id, so a dead id is enough to remove
    // the file — no JSON parsing and no risk of touching a live record.
    const files = []
    await collectFiles(path, 2, files)
    for (const file of files) {
      const id = recordBackupId(basename(file))
      if (id === undefined || known.ids.has(id)) continue
      scanned += 1
      const before = await fileSize(file)
      try {
        await rm(file, { force: true })
        removed += 1
        freedBytes += before
      } catch {
        // Leave it: another sweep can retry.
      }
    }
  }
  return { scanned, removed, freedBytes, staleIds }
}

/**
 * Drop unknown Session ids from every string array in a storage document.
 *
 * The walk is generic on purpose: the backup of a Workspace unit nests ids in
 * `global.archivedSessionIds` and inside each table record's `sessionIds`, and a
 * future unit may put them somewhere else. Only values that look like a Session
 * id and are unknown are dropped; everything else is left byte-for-byte intact.
 */
function scrubSessionIds(value, known, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return 0
  let removed = 0
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index]
      if (typeof item === 'string' && SESSION_ID.test(item) && !known.has(item)) {
        value.splice(index, 1)
        removed += 1
      } else {
        removed += scrubSessionIds(item, known, depth + 1)
      }
    }
    return removed
  }
  for (const key of Object.keys(value)) {
    removed += scrubSessionIds(value[key], known, depth + 1)
  }
  return removed
}

/** `<DSH_HOME>/storages`, next to the sessions root. */
function storagesDirectory(host) {
  const root = sessionsRoot(host)
  if (root === undefined) return undefined
  return join(resolve(root, '..'), 'storages')
}

/** Collect files under a directory, down to `depth` levels below it. */
async function collectFiles(directory, depth, out) {
  if (depth < 0) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isFile()) out.push(path)
    else if (entry.isDirectory()) await collectFiles(path, depth - 1, out)
  }
}

/**
 * The Session id inside a per-record storage backup name, or `undefined`.
 *
 * The storage layer names these `<id>.json.bak.<YYYYMMDDHHmm>` when a record
 * cannot be parsed. Only the Session-shaped prefix is accepted; anything else
 * is a backup of some other unit and must not be matched by accident.
 */
function recordBackupId(name) {
  const marker = name.indexOf('.json.bak.')
  if (marker < 0) return undefined
  const id = name.slice(0, marker)
  return SESSION_ID.test(id) ? id : undefined
}

/** Delete every per-record backup that belongs to one Session. */
async function removeRecordBackups(host, sessionId) {
  const directory = storagesDirectory(host)
  if (directory === undefined) return 0
  const files = []
  await collectFiles(directory, 2, files)
  let removed = 0
  for (const file of files) {
    if (recordBackupId(basename(file)) !== sessionId) continue
    try {
      await rm(file, { force: true })
      removed += 1
    } catch {
      // Leave it: another sweep can retry.
    }
  }
  return removed
}

/** Collect `.json` files under a directory, down to `depth` levels below it. */
async function collectJsonFiles(directory, depth, out) {
  if (depth < 0) return
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isFile()) {
      if (entry.name.endsWith('.json')) out.push(path)
      continue
    }
    if (entry.isDirectory() && depth > 0) await collectJsonFiles(path, depth - 1, out)
  }
}

/**
 * Best-effort removal of deleted Session ids from third-party caches.
 *
 * DSH itself is cleaned through the services above, but other plugins keep their
 * own JSON caches under DSH_HOME — a context overview, a per-session usage
 * ledger, and similar. There is no contract for those files, so this only
 * removes values that are unmistakably references to a deleted Session: object
 * keys equal to the id, array entries that are the id, and array entries whose
 * `id` or `session.id` is the id. Anything else is left untouched, and a file
 * that cannot be parsed is skipped rather than rewritten.
 */
async function scrubExternalCaches(host, ids) {
  const root = sessionsRoot(host)
  if (root === undefined || ids.length === 0) return 0
  const home = resolve(root, '..')
  const targets = []
  await collectJsonFiles(join(home, 'storages'), 3, targets)
  // Plugin-owned ledgers live one level under DSH_HOME, e.g.
  // `<home>/dsh-claude-style/usage.json`; only direct files are considered.
  let top
  try {
    top = await readdir(home, { withFileTypes: true })
  } catch {
    top = []
  }
  const skip = new Set(['sessions', 'storages', 'profiles', 'dsh-runtimes', 'node_modules', 'logs', 'cache'])
  for (const entry of top) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || skip.has(entry.name)) continue
    await collectJsonFiles(join(home, entry.name), 0, targets)
  }
  // Storage-layer artifacts already have dedicated sweeps: the projection cache
  // through its domain table, and every `.bak` file through the backup sweep.
  const candidates = targets.filter((path) => !path.includes(`${sep}session_projcache${sep}`) && !basename(path).includes('.bak'))
  const wanted = new Set(ids)
  let changed = 0
  for (const path of candidates) {
    try {
      const size = await fileSize(path)
      if (size === 0 || size > 4 * 1024 * 1024) continue
      const text = await readTextFile(path)
      let mentions = false
      for (const id of wanted) {
        if (text.includes(id)) {
          mentions = true
          break
        }
      }
      if (!mentions) continue
      const document = JSON.parse(text)
      const count = scrubSessionRefs(document, wanted)
      if (count === 0) continue
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      changed += count
    } catch {
      // A cache with an unexpected shape is left alone.
    }
  }
  return changed
}

/** Remove deleted Session references from a parsed JSON document. */
function scrubSessionRefs(value, wanted, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return 0
  let changed = 0
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index]
      if (typeof item === 'string') {
        if (wanted.has(item)) {
          value.splice(index, 1)
          changed += 1
        }
        continue
      }
      if (item !== null && typeof item === 'object') {
        const id = sessionIdOf(item)
        if (id !== undefined && wanted.has(id)) {
          value.splice(index, 1)
          changed += 1
          continue
        }
        changed += scrubSessionRefs(item, wanted, depth + 1)
      }
    }
    return changed
  }
  for (const key of Object.keys(value)) {
    if (wanted.has(key)) {
      delete value[key]
      changed += 1
      continue
    }
    changed += scrubSessionRefs(value[key], wanted, depth + 1)
  }
  return changed
}

/** The Session id a record-like object carries, if any. */
function sessionIdOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.id === 'string' && SESSION_ID.test(value.id)) return value.id
  const session = value.session
  if (session !== null && typeof session === 'object' && typeof session.id === 'string' && SESSION_ID.test(session.id)) {
    return session.id
  }
  return undefined
}

/** Answer one HTTP request. Always writes a response; never throws at the caller. */
async function handlePurge(host, request, response) {
  if (request.method !== 'POST') {
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
 *
 * Sub-agent Sessions are collected first and purged with their ancestor: their
 * logs sit in directories of their own, and the sidebar hides them, so a
 * leftover child would be a copy nobody can see or delete afterwards.
 */
async function purgeSession(host, sessionId) {
  const registry = host.get('workspaceRegistry')
  const persistence = host.get('sessionPersistence')

  const familyLookup = await descendantSessionIds(host, sessionId)
  const family = [sessionId, ...familyLookup.ids]
  const seen = new Set(family)

  let stopped = false
  let released = 0
  let workspaces = 0
  let directories = []
  let cacheRemoved = 0
  let leftovers = []
  let directoriesUnresolved = false
  let backupsRemoved = 0
  let cachesScrubbed = 0

  // Waiting is budgeted per family, not per member: a Session with three
  // sub-agents would otherwise hold the request for nine seconds before the
  // first file was even touched.
  let budget = IDLE_TIMEOUT_MS
  for (const id of family) {
    if (await stopActivity(registry, id)) stopped = true
    const waited = await waitForIdle(host, id, Math.max(budget, 0))
    budget -= waited
    if (releaseLiveSession(host, id)) released += 1
  }

  // A parent that was still running can spawn one more child while it drains.
  // Look again now that everything is stopped: a child created between the two
  // passes would otherwise keep its log after the deletion reports success.
  const lateLookup = await descendantSessionIds(host, sessionId)
  const familyResolved = familyLookup.resolved === true && lateLookup.resolved === true
  for (const id of lateLookup.ids) {
    if (seen.has(id)) continue
    seen.add(id)
    family.push(id)
    if (await stopActivity(registry, id)) stopped = true
    // A child found in this pass may also be draining a turn; wait on the same
    // budget before its writer is released, or Windows may keep the log locked.
    const waited = await waitForIdle(host, id, Math.max(budget, 0))
    budget -= waited
    if (releaseLiveSession(host, id)) released += 1
  }

  if (registry !== undefined) {
    // `list()` throws while the registry is still starting; the deletion is not
    // the place to surface that, and the files below still have to go.
    for (const workspace of await listWorkspaces(registry)) {
      try {
        // `sessionIds` is already filtered by the Workspace's own membership test,
        // so reading it first is what turns the count into "actually detached".
        const listed = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)
        await workspace.detachSession(sessionId)
        if (listed) workspaces += 1
      } catch {
        // One unwritable Workspace must not block the deletion.
      }
    }
    // The whole family leaves the archive and pin sets: a child id that somehow
    // got archived would otherwise be invisible to both the list and this sweep.
    for (const id of family) {
      await settle(() => registry.unarchiveSession(id))
      await settle(() => registry.unpinSession(id))
    }
  }

  // The persistence layer closes a released Session's writer on its own, but it
  // does that asynchronously: flushing first keeps Windows from refusing the
  // unlink of a file that is still held open.
  await settle(() => persistence?.flush?.())

  const root = typeof persistence?.root === 'string' && persistence.root.length > 0
    ? persistence.root
    : undefined
  if (root !== undefined) {
    for (const id of family) {
      const found = await findSessionDirectories(root, id)
      if (found === null) {
        // The sessions root exists but cannot be listed. Reporting an empty
        // `directories` here would turn a failed sweep into a clean one.
        directoriesUnresolved = true
        continue
      }
      for (const directory of found) {
        const result = await removeDirectory(directory)
        if (result === true) directories.push(directory)
        else leftovers.push(directory)
      }
    }
  }

  // The storage layer keeps per-record backups named after the record they
  // copied; a deleted Session must not survive in one of those either.
  for (const id of family) backupsRemoved += await removeRecordBackups(host, id)

  for (const id of family) if (await forgetProjection(host, id)) cacheRemoved += 1

  // Third-party caches are outside the Host's own contracts; this is best effort
  // and never turns a successful deletion into a failure.
  cachesScrubbed = await scrubExternalCaches(host, family)

  return {
    sessionId,
    descendants: family.length - 1,
    descendantsUnresolved: familyResolved !== true,
    stopped,
    released,
    workspaces,
    directories,
    directoriesUnresolved,
    leftovers,
    cacheRemoved,
    backupsRemoved,
    cachesScrubbed,
  }
}

/** The Workspace entities, or none while the registry is not started yet. */
async function listWorkspaces(registry) {
  try {
    const workspaces = registry.list()
    return Array.isArray(workspaces) ? workspaces : []
  } catch {
    return []
  }
}

/**
 * Every sub-agent Session that descends from this one, at any depth.
 *
 * The Host's own child lookup (`listArtifacts` filtered by `header.parentSession`)
 * is the only reliable source: the relationship lives in each child's header, not
 * in a directory name. A cycle is impossible in practice but is still guarded, so
 * a corrupted header cannot make the deletion loop forever.
 *
 * `parentSession` alone is not enough: forking a Session also records the source
 * id there, but a fork is a first-class Session the sidebar shows and the user
 * keeps working in. The Host's own child lookup therefore requires
 * `origin === "subagent"` as well, and so does this walk.
 *
 * `listSessions` merges the live and persisted corpora and throws when the two
 * disagree about one Session. That is not a reason to skip the children — their
 * logs would survive a deletion that reported success — so the raw persistence
 * listing is used instead. Only when both sources fail is the family incomplete,
 * and the caller is told about it through `descendantsUnresolved`.
 */
async function descendantSessionIds(host, sessionId) {
  const records = await sessionHeaders(host)
  const children = new Map()
  for (const record of records ?? []) {
    const parent = record?.header?.parentSession
    const id = record?.header?.id
    if (record?.header?.origin !== 'subagent') continue
    if (typeof parent !== 'string' || typeof id !== 'string' || parent === id) continue
    const bucket = children.get(parent)
    if (bucket === undefined) children.set(parent, [id])
    else bucket.push(id)
  }
  const found = []
  const seen = new Set([sessionId])
  const queue = [sessionId]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  // `null` records mean neither source answered: the family may be missing
  // children, and the caller must not report a complete deletion.
  return { ids: found, resolved: records !== null }
}

/**
 * Session records from the richest source that answers, or `null`.
 *
 * `sessionQuery` merges the live and persisted corpora but refuses to answer when
 * the two disagree about one Session (`SESSION_QUERY_SOURCE_CONFLICT`);
 * `sessionPersistence.list()` reads the logs alone and therefore always answers.
 * The merged view is preferred because a Session created in this run may not have
 * reached the disk yet, but the fallback is what keeps a deletion honest when the
 * merge fails.
 */
async function sessionHeaders(host) {
  const query = host.get('sessionQuery')
  if (query !== undefined && typeof query.listSessions === 'function') {
    try {
      const records = await query.listSessions()
      if (Array.isArray(records)) return records
    } catch {
      // Fall through: the persistence listing below still knows the children.
    }
  }
  const persistence = host.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.list !== 'function') return null
  try {
    const records = await persistence.list()
    return Array.isArray(records) ? records : null
  } catch {
    return null
  }
}

/**
 * Remove one Session directory; report whether it is gone.
 *
 * A failed unlink is not a failed deletion: the Session is already out of the
 * Host's list and out of the Workspace, so the caller reports the path as a
 * leftover instead of answering 500 for a deletion that mostly happened.
 */
async function removeDirectory(directory) {
  try {
    await rm(directory, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
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
 *
 * Returns how long it waited, so a caller with several Sessions to stop can spend
 * one budget across the family instead of one timeout each.
 */
async function waitForIdle(host, sessionId, timeoutMs) {
  if (typeof host.waterfall !== 'function') return 0
  const started = Date.now()
  const deadline = started + Math.max(timeoutMs, 0)
  for (;;) {
    let activity
    try {
      activity = await host.waterfall('workspace/session-activity', { sessionId }, () => [])
    } catch {
      return Date.now() - started
    }
    if (!Array.isArray(activity) || activity.length === 0) return Date.now() - started
    if (Date.now() >= deadline) return Date.now() - started
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
 *
 * `null` means the root could not be listed at all. That is different from "the
 * Session has no directory": the caller must report an incomplete sweep instead
 * of claiming the logs are gone.
 */
async function findSessionDirectories(root, sessionId) {
  const resolvedRoot = resolve(root)
  let entries
  try {
    entries = await readdir(resolvedRoot, { withFileTypes: true })
  } catch {
    return null
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

/**
 * Delete the projection-cache record; the cache has no public delete either.
 *
 * Reports whether a record was actually removed: `table.delete` answers false for
 * a key that was never there, and counting that as a removal would make
 * `cacheRemoved` an attempt count instead of a result.
 */
async function forgetProjection(host, sessionId) {
  const table = host.get('sessionProjectionCache')?.table
  if (table === undefined || typeof table.delete !== 'function') return false
  try {
    return (await table.delete(sessionId)) !== false
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

/** Read an optional id set; `undefined` when the source cannot answer yet. */
async function readSet(read) {
  try {
    const value = read()
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
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
  if (url.host.toLowerCase() === header.trim().toLowerCase()) return true
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

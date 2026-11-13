/**
 * Smoke test for dsh-session-manager's Host half.
 *
 * Loads the real `lib/index.js` with a fake Cordis context, a fake webServer and
 * a throw-away DSH_HOME, then drives the five HTTP handlers the browser half
 * calls. Checks the request fence, the id validation, the purge order, that the
 * targeted Session and its sub-agent descendants are removed while a sibling is
 * kept, that the flush runs before the unlink, and that all three housekeeping
 * sweeps leave live Sessions and their records alone.
 *
 * Run: node test/host-smoke.mjs
 */

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOST = fileURLToPath(new URL('../lib/index.js', import.meta.url))

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/* ------------------------------------------------------------------ fakes */

function makeRequest({ method = 'POST', headers = {}, body = '' } = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
}

function makeResponse() {
  const response = { status: 0, headers: {}, body: '' }
  response.writeHead = (status, headers) => {
    response.status = status
    response.headers = headers ?? {}
  }
  response.end = (chunk) => {
    response.body = typeof chunk === 'string' ? chunk : ''
  }
  return response
}

const routes = new Map()
const services = new Map()
const effects = []

const ctx = {
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(key) {
    return services.get(key)
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  waterfall: async () => [],
}

/* ------------------------------------------------------------- DSH_HOME    */

// One disposable DSH_HOME: sessions/ next to storages/, exactly like the real one.
const base = await mkdtemp(join(tmpdir(), 'sp-host-'))
const root = join(base, 'sessions')
const project = join(root, '--D-Develop-demo--')
const target = join(project, 'session-manager-test')
const child = join(project, 'session-manager-child')
const grandchild = join(project, 'session-manager-grandchild')
const unrelated = join(project, 'session-unrelated')
const kept = join(project, 'session-keep-test')
const emptyProject = join(root, '--D-Develop-empty--')
const cacheDir = join(base, 'storages', 'session_projcache', 'sessions')
const storagesDir = join(base, 'storages')
await mkdir(target, { recursive: true })
await mkdir(child, { recursive: true })
await mkdir(grandchild, { recursive: true })
await mkdir(unrelated, { recursive: true })
await mkdir(kept, { recursive: true })
await mkdir(emptyProject, { recursive: true })
await mkdir(cacheDir, { recursive: true })
await writeFile(join(target, 'session.v4.jsonl.zstd'), 'log')
await writeFile(join(child, 'session.v4.jsonl.zstd'), 'log')
await writeFile(join(grandchild, 'session.v4.jsonl.zstd'), 'log')
await writeFile(join(unrelated, 'session.v4.jsonl.zstd'), 'log')
await writeFile(join(kept, 'session.v4.jsonl.zstd'), 'log')
await writeFile(join(cacheDir, 'session-manager-test.json'), '{"rows":[]}')
await writeFile(join(cacheDir, 'session-manager-child.json'), '{"rows":[]}')
await writeFile(join(cacheDir, 'session-orphan-one.json'), 'x'.repeat(100))
await writeFile(join(cacheDir, 'session-orphan-two.json'), 'y'.repeat(50))
await writeFile(join(cacheDir, 'session-keep-test.json'), '{"rows":[]}')

// Two storage backups, one naming a Session that is about to be deleted and one
// naming only live Sessions. Only the first may be rewritten.
const staleBackup = join(storagesDir, 'workspace.json.bak-1000')
const liveBackup = join(storagesDir, 'workspace.json.bak-2000')
await writeFile(staleBackup, JSON.stringify({
  global: { archivedSessionIds: ['session-manager-test', 'session-keep-test', 'session-gone-forever'] },
  tables: { workspaces: { w1: { sessionIds: ['session-manager-test', 'session-keep-test'] } } },
}, null, 2))
await writeFile(liveBackup, JSON.stringify({
  global: { archivedSessionIds: ['session-keep-test'] },
}, null, 2))

const detached = []
const registryCalls = []
const workspaces = [
  { sessionIds: ['session-manager-test', 'session-keep-test'], detachSession: async (id) => { detached.push(`first:${id}`) } },
  { sessionIds: ['session-keep-test'], detachSession: async (id) => { detached.push(`second:${id}`) } },
]
// The registry's global archive and pin sets: the sweep must drop ids the Host no
// longer knows and leave live ones alone.
const archivedIds = ['session-keep-test', 'session-gone-forever']
const pinnedIds = ['session-gone-forever']
services.set('workspaceRegistry', {
  list: () => workspaces,
  get archivedSessionIds() { return archivedIds },
  get pinnedSessionIds() { return pinnedIds },
  async stopSessionActivity(id) { registryCalls.push(`stop:${id}`) },
  async unarchiveSession(id) {
    registryCalls.push(`unarchive:${id}`)
    const at = archivedIds.indexOf(id)
    if (at === -1) return
    archivedIds.splice(at, 1)
  },
  async unpinSession(id) {
    registryCalls.push(`unpin:${id}`)
    const at = pinnedIds.indexOf(id)
    if (at === -1) return
    pinnedIds.splice(at, 1)
  },
})

let flushed = 0
services.set('sessionPersistence', {
  root,
  async flush() { flushed += 1 },
  // The raw persistence listing: always answers, even when the merged view cannot.
  async list() { return headers.map((header) => ({ header })) },
})

// The live Session registry: detaching an entry removes it from the store, which
// is what makes the id unknown to the Host from then on.
const released = []
const liveStore = new Map()
for (const id of ['session-manager-test', 'session-manager-child']) {
  liveStore.set(id, { detach: () => { released.push(id); liveStore.delete(id) } })
}
services.set('sessions', { store: liveStore })

// The projection cache is a storage table: keys() lists records, delete() drops one.
const cacheRecords = new Set([
  'session-manager-test',
  'session-manager-child',
  'session-orphan-one',
  'session-orphan-two',
  'session-keep-test',
])
const cacheDeletes = []
const cacheTable = {
  keys: () => cacheRecords.keys(),
  async delete(id) {
    cacheDeletes.push(id)
    if (!cacheRecords.has(id)) return false
    cacheRecords.delete(id)
    return true
  },
}
services.set('sessionProjectionCache', { table: cacheTable })

// parent → child edges the Host derives from each child's own header.
const headers = [
  { id: 'session-manager-test', createdAt: 1 },
  { id: 'session-manager-child', createdAt: 2, parentSession: 'session-manager-test', origin: 'subagent' },
  { id: 'session-manager-grandchild', createdAt: 3, parentSession: 'session-manager-child', origin: 'subagent' },
  { id: 'session-unrelated', createdAt: 4, parentSession: 'session-other', origin: 'subagent' },
  { id: 'session-keep-test', createdAt: 5 },
]
services.set('sessionQuery', {
  async listSessions() {
    return [
      ...headers.map((header) => ({ header, live: false })),
      { record: 'not a header' },
    ]
  },
})

/* ------------------------------------------------------------------- load */

const host = await import(pathToFileURL(HOST).href)
check('host exports a name', host.name === 'session-manager')
check('host declares the webServer dependency', Array.isArray(host.inject) && host.inject.includes('webServer'))

host.apply(ctx)

const PURGE = '/session-manager/api/purge'
const INVENTORY = '/session-manager/api/inventory'
const CACHE_UPKEEP = '/session-manager/api/maintenance/cache'
const DIRECTORY_UPKEEP = '/session-manager/api/maintenance/directories'
const BACKUP_UPKEEP = '/session-manager/api/maintenance/backups'

check(
  'the host registers all five routes',
  routes.has(PURGE) && routes.has(INVENTORY) && routes.has(CACHE_UPKEEP) && routes.has(DIRECTORY_UPKEEP) && routes.has(BACKUP_UPKEEP),
  [...routes.keys()].join(', '),
)
check('every registration is a managed effect', effects.length === 5, String(effects.length))

const purge = routes.get(PURGE)
const inventory = routes.get(INVENTORY)
const cacheUpkeep = routes.get(CACHE_UPKEEP)
const directoryUpkeep = routes.get(DIRECTORY_UPKEEP)
const backupUpkeep = routes.get(BACKUP_UPKEEP)

async function call(route, request) {
  const response = makeResponse()
  await route.handler(request, response)
  return { response, payload: response.body === '' ? undefined : JSON.parse(response.body) }
}

/* -------------------------------------------------------------- inventory */

let result = await call(inventory, makeRequest({ method: 'GET' }))
check('the inventory route answers GET', result.response.status === 200 && result.payload.ok === true)
check('the inventory route maps headers', result.payload.sessions.length === 5, JSON.stringify(result.payload.sessions))
check('the inventory route keeps creation times', result.payload.sessions[0].createdAt === 1)
check('the inventory route reports parent and origin', result.payload.sessions[1].parentId === 'session-manager-test' && result.payload.sessions[1].origin === 'subagent')

result = await call(inventory, makeRequest({ method: 'POST' }))
check('the inventory route refuses POST', result.response.status === 405 && result.response.headers.allow === 'GET')

/* ------------------------------------------------------------------ fence */

services.set('connection', { requestRejection: () => 401 })
result = await call(purge, makeRequest({ body: JSON.stringify({ sessionId: 'session-manager-test' }) }))
check('the request fence runs before the body', result.response.status === 401 && result.payload.error === 'refused', String(result.response.status))
result = await call(cacheUpkeep, makeRequest({ body: '{}' }))
check('the fence also guards housekeeping', result.response.status === 401 && result.payload.error === 'refused', String(result.response.status))
result = await call(backupUpkeep, makeRequest({ body: '{}' }))
check('the fence also guards the backup sweep', result.response.status === 401 && result.payload.error === 'refused', String(result.response.status))
services.delete('connection')

result = await call(purge, makeRequest({ body: '{}', headers: { 'sec-fetch-site': 'cross-site' } }))
check('a cross-site request is refused', result.response.status === 403, String(result.response.status))

result = await call(purge, makeRequest({ body: '{}', headers: { origin: 'http://evil.example', host: '127.0.0.1:60368' } }))
check('a foreign origin is refused', result.response.status === 403, String(result.response.status))

result = await call(purge, makeRequest({ body: '{}', headers: { origin: 'http://127.0.0.1:60368', host: '127.0.0.1:60368' } }))
check('a same-origin request passes the fence', result.response.status === 400, String(result.response.status))

result = await call(purge, makeRequest({ body: '{}', headers: { origin: 'http://127.0.0.1', host: '127.0.0.1:60368' } }))
check('a loopback origin without a port passes the fence', result.response.status === 400, String(result.response.status))

/* ------------------------------------------------------------- validation */

result = await call(purge, makeRequest({ method: 'GET' }))
check('the purge route refuses GET', result.response.status === 405 && result.response.headers.allow === 'POST')

result = await call(purge, makeRequest({ body: 'not json' }))
check('a broken body is a 400', result.response.status === 400 && result.payload.error === 'invalid-request')

result = await call(purge, makeRequest({ body: JSON.stringify({ sessionId: '../escape' }) }))
check('a traversal-shaped id is refused', result.response.status === 400 && result.payload.error === 'invalid-session-id')

/* ----------------------------------------------------------------- purge */

// A child that somehow got archived and a grandchild that got pinned: deleting the
// ancestor must clear those too, or the ids would be invisible to both the list
// and the sweep that follows.
archivedIds.push('session-manager-child')
pinnedIds.push('session-manager-grandchild')

result = await call(purge, makeRequest({ body: JSON.stringify({ sessionId: 'session-manager-test' }) }))
check('the purge answers 200', result.response.status === 200 && result.payload.ok === true, JSON.stringify(result.payload))
check('the purge stops activity first', registryCalls[0] === 'stop:session-manager-test', JSON.stringify(registryCalls))
check('the purge stops activity for the descendants too', registryCalls.includes('stop:session-manager-child') && registryCalls.includes('stop:session-manager-grandchild'))
check('the purge drops only the workspaces that listed the Session', detached.length === 2 && result.payload.workspaces === 1, JSON.stringify({ detached, workspaces: result.payload.workspaces }))
check('the purge clears archive and pin ids', registryCalls.includes('unarchive:session-manager-test') && registryCalls.includes('unpin:session-manager-test'))
check(
  'the purge clears the archive and pin sets of the whole family',
  !archivedIds.includes('session-manager-child') && !pinnedIds.includes('session-manager-grandchild'),
  JSON.stringify({ archivedIds, pinnedIds }),
)
check('the purge releases every live Session in the family', released.sort().join(',') === 'session-manager-child,session-manager-test', released.join(','))
check('the purge flushes persistence before unlinking', flushed === 1, String(flushed))
check('the purge counts the descendants it followed', result.payload.descendants === 2, String(result.payload.descendants))
check('a resolved family is not reported as unresolved', result.payload.descendantsUnresolved === false, JSON.stringify(result.payload))
check(
  'the purge deletes the projection cache of the whole family',
  cacheDeletes.slice().sort().join(',') === 'session-manager-child,session-manager-grandchild,session-manager-test',
  cacheDeletes.join(','),
)
check(
  'the purge removed the Session and its descendants',
  !existsSync(target) && !existsSync(child) && !existsSync(grandchild),
)
check('the purge kept the unrelated sibling logs', existsSync(kept) && existsSync(unrelated))
check('the purge reports three removed directories', Array.isArray(result.payload.directories) && result.payload.directories.length === 3, JSON.stringify(result.payload.directories))
check('a clean purge reports no leftovers', Array.isArray(result.payload.leftovers) && result.payload.leftovers.length === 0)

// A second purge of the same Session stays harmless.
result = await call(purge, makeRequest({ body: JSON.stringify({ sessionId: 'session-manager-test' }) }))
check('a repeated purge stays harmless', result.response.status === 200 && result.payload.directories.length === 0)

/* ------------------------------------------------------------- housekeeping */

result = await call(cacheUpkeep, makeRequest({ method: 'GET' }))
check('cache housekeeping refuses GET', result.response.status === 405 && result.response.headers.allow === 'POST', String(result.response.status))

const deletesBeforeUpkeep = cacheDeletes.length
result = await call(cacheUpkeep, makeRequest({ body: '{}' }))
check('cache housekeeping answers 200', result.response.status === 200 && result.payload.ok === true, JSON.stringify(result.payload))
check('cache housekeeping drops exactly the orphaned records', result.payload.removed === 2, JSON.stringify(result.payload))
check('cache housekeeping reports the freed bytes', result.payload.freedBytes === 150, JSON.stringify(result.payload))
check(
  'cache housekeeping keeps the live Session records',
  cacheRecords.has('session-keep-test') && !cacheRecords.has('session-orphan-one') && !cacheRecords.has('session-orphan-two'),
  [...cacheRecords].join(', '),
)
check(
  'cache housekeeping only deletes orphaned ids',
  cacheDeletes.slice(deletesBeforeUpkeep).sort().join(',') === 'session-orphan-one,session-orphan-two',
  cacheDeletes.join(', '),
)

result = await call(directoryUpkeep, makeRequest({ body: '{}' }))
check('folder housekeeping answers 200', result.response.status === 200 && result.payload.ok === true, JSON.stringify(result.payload))
check('folder housekeeping removes only the empty project folder', result.payload.removed === 1, JSON.stringify(result.payload))
check('folder housekeeping kept the project folder that still holds a Session', existsSync(kept) && !existsSync(emptyProject))

result = await call(backupUpkeep, makeRequest({ body: '{}' }))
check('backup housekeeping answers 200', result.response.status === 200 && result.payload.ok === true, JSON.stringify(result.payload))
check('backup housekeeping rewrites only the backup naming a dead Session', result.payload.removed === 1, JSON.stringify(result.payload))
check('backup housekeeping counts the ids it dropped from the live registry', result.payload.staleIds === 2, JSON.stringify(result.payload))
check(
  'backup housekeeping empties the dead ids out of the archive set',
  archivedIds.join(',') === 'session-keep-test',
  archivedIds.join(','),
)
check('backup housekeeping empties the dead ids out of the pin set', pinnedIds.length === 0, pinnedIds.join(','))
const scrubbed = await readFile(staleBackup, 'utf8')
check('backup housekeeping dropped the dead Session id', !scrubbed.includes('session-gone-forever') && !scrubbed.includes('session-manager-test'), scrubbed)
check('backup housekeeping kept the live Session id', scrubbed.includes('session-keep-test'), scrubbed)
const untouched = await readFile(liveBackup, 'utf8')
check('backup housekeeping leaves a clean backup alone', untouched.includes('session-keep-test'), untouched)

// A registry that is still starting cannot answer its id sets. The file sweep is
// the actual job and must still run: failing over a set nobody can read yet would
// report "nothing to clean up" for a Host that has work to do.
const realRegistry = services.get('workspaceRegistry')
services.set('workspaceRegistry', {
  list: realRegistry.list,
  get archivedSessionIds() { throw new Error('workspace registry is not started yet') },
  get pinnedSessionIds() { throw new Error('workspace registry is not started yet') },
  async stopSessionActivity() {},
  async unarchiveSession() {},
  async unpinSession() {},
})
result = await call(backupUpkeep, makeRequest({ body: '{}' }))
check(
  'backup housekeeping survives an unreadable registry',
  result.response.status === 200 && result.payload.ok === true && result.payload.staleIds === 0,
  JSON.stringify(result.payload),
)
services.set('workspaceRegistry', realRegistry)

// The same for the purge: a registry that cannot list workspaces must not stop the
// files from being removed.
services.set('workspaceRegistry', {
  list() { throw new Error('workspace registry is not started yet') },
  get archivedSessionIds() { return [] },
  get pinnedSessionIds() { return [] },
  async stopSessionActivity() {},
  async unarchiveSession() {},
  async unpinSession() {},
})
result = await call(purge, makeRequest({ body: JSON.stringify({ sessionId: 'session-keep-test' }) }))
check(
  'a purge survives a registry that cannot list',
  result.response.status === 200 && result.payload.ok === true && result.payload.workspaces === 0,
  JSON.stringify(result.payload),
)
services.set('workspaceRegistry', realRegistry)

// A Host without a projection-cache table cannot sweep the cache: it says so.
services.delete('sessionProjectionCache')
result = await call(cacheUpkeep, makeRequest({ body: '{}' }))
check('cache housekeeping reports an unavailable cache', result.response.status === 200 && result.payload.skipped === 'projection-cache-unavailable', JSON.stringify(result.payload))

services.set('sessionProjectionCache', { table: { keys() { throw new Error('table offline') }, async delete() { return false } } })
result = await call(cacheUpkeep, makeRequest({ body: '{}' }))
check('cache housekeeping reports an unreadable cache', result.response.status === 200 && result.payload.skipped === 'projection-cache-unreadable', JSON.stringify(result.payload))

// A Host whose storages directory is missing cannot sweep backups at all. The
// directory is the sessions root's sibling, so both have to be absent.
const orphanRoot = join(base, 'orphan-home', 'sessions')
await mkdir(join(base, 'orphan-home'), { recursive: true })
services.set('sessionPersistence', { root: orphanRoot, async flush() {} })
result = await call(backupUpkeep, makeRequest({ body: '{}' }))
check('backup housekeeping reports unreadable storages', result.response.status === 200 && result.payload.skipped === 'storages-unreadable', JSON.stringify(result.payload))

// A real fault is a 500, not a crash.
services.set('sessionPersistence', {
  root,
  async flush() {},
  async list() { return headers.map((header) => ({ header })) },
})
services.set('sessionProjectionCache', { table: cacheTable })
const realGet = ctx.get
ctx.get = (key) => {
  if (key === 'sessionProjectionCache') throw new Error('boom')
  return realGet(key)
}
result = await call(cacheUpkeep, makeRequest({ body: '{}' }))
check('a housekeeping failure is a 500', result.response.status === 500 && result.payload.error === 'upkeep-failed', JSON.stringify(result.payload))
ctx.get = realGet

// A merged-view failure falls back to the raw persistence listing instead of
// losing the console.
services.set('sessionQuery', { async listSessions() { throw new Error('index offline') } })
result = await call(inventory, makeRequest({ method: 'GET' }))
check(
  'an inventory falls back to the persistence listing',
  result.response.status === 200 && Array.isArray(result.payload.sessions) && result.payload.sessions.length === 5,
  JSON.stringify(result.payload),
)

// With both sources down the failure is reported, not thrown.
services.set('sessionPersistence', { root, async flush() {}, async list() { throw new Error('logs offline') } })
result = await call(inventory, makeRequest({ method: 'GET' }))
check(
  'an inventory failure is reported',
  result.response.status === 500 && result.payload.error === 'inventory-failed',
  JSON.stringify(result.payload),
)

// A purge whose descendant lookup fails still deletes the Session itself, and
// says that the family is incomplete.
result = await call(purge, makeRequest({ body: JSON.stringify({ sessionId: 'session-keep-test' }) }))
check(
  'a broken descendant lookup still purges the target',
  result.response.status === 200 && result.payload.descendants === 0 && result.payload.descendantsUnresolved === true && !existsSync(kept),
  JSON.stringify(result.payload),
)

await rm(base, { recursive: true, force: true })

check('the temporary DSH_HOME is cleaned up', !existsSync(base))

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}

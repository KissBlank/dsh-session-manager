/**
 * Smoke test for dsh-session-manager's Host half.
 *
 * Loads the real `lib/index.js` with a fake Cordis context, a fake webServer and
 * a throw-away DSH_HOME, then drives the four HTTP handlers the browser half
 * calls. Checks the request fence, the id validation, the purge order, that only
 * the targeted Session directory is removed, and that both housekeeping sweeps
 * leave live Sessions and their records alone.
 *
 * Run: node test/host-smoke.mjs
 */

import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises'
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
const target = join(root, '--D-Develop-demo--', 'session-manager-test')
const kept = join(root, '--D-Develop-demo--', 'session-keep-test')
const emptyProject = join(root, '--D-Develop-empty--')
const cacheDir = join(base, 'storages', 'session_projcache', 'sessions')
await mkdir(target, { recursive: true })
await mkdir(kept, { recursive: true })
await mkdir(emptyProject, { recursive: true })
await mkdir(cacheDir, { recursive: true })
await writeFile(join(target, 'session.v4.jsonl.zstd'), 'log')
await writeFile(join(kept, 'session.v4.jsonl.zstd'), 'log')
await writeFile(join(cacheDir, 'session-manager-test.json'), '{"rows":[]}')
await writeFile(join(cacheDir, 'session-orphan-one.json'), 'x'.repeat(100))
await writeFile(join(cacheDir, 'session-orphan-two.json'), 'y'.repeat(50))
await writeFile(join(cacheDir, 'session-keep-test.json'), '{"rows":[]}')

const detached = []
const registryCalls = []
const workspaces = [
  { detachSession: async (id) => { detached.push(`first:${id}`) } },
  { detachSession: async (id) => { detached.push(`second:${id}`) } },
]
services.set('workspaceRegistry', {
  list: () => workspaces,
  async stopSessionActivity(id) { registryCalls.push(`stop:${id}`) },
  async unarchiveSession(id) { registryCalls.push(`unarchive:${id}`) },
  async unpinSession(id) { registryCalls.push(`unpin:${id}`) },
})

services.set('sessionPersistence', { root })

let released = null
services.set('sessions', {
  store: new Map([['session-manager-test', { detach: () => { released = 'session-manager-test' } }]]),
})

// The projection cache is a storage table: keys() lists records, delete() drops one.
const cacheRecords = new Set([
  'session-manager-test',
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

services.set('sessionQuery', {
  async listSessions() {
    return [
      { header: { id: 'session-one', createdAt: 1, parentSession: 'session-root', origin: 'subagent' }, live: false },
      { header: { id: 'session-two' }, live: true },
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

check(
  'the host registers all four routes',
  routes.has(PURGE) && routes.has(INVENTORY) && routes.has(CACHE_UPKEEP) && routes.has(DIRECTORY_UPKEEP),
  [...routes.keys()].join(', '),
)
check('every registration is a managed effect', effects.length === 4, String(effects.length))

const purge = routes.get(PURGE)
const inventory = routes.get(INVENTORY)
const cacheUpkeep = routes.get(CACHE_UPKEEP)
const directoryUpkeep = routes.get(DIRECTORY_UPKEEP)

async function call(route, request) {
  const response = makeResponse()
  await route.handler(request, response)
  return { response, payload: response.body === '' ? undefined : JSON.parse(response.body) }
}

/* -------------------------------------------------------------- inventory */

let result = await call(inventory, makeRequest({ method: 'GET' }))
check('the inventory route answers GET', result.response.status === 200 && result.payload.ok === true)
check('the inventory route maps headers', result.payload.sessions.length === 2)
check('the inventory route keeps creation times', result.payload.sessions[0].createdAt === 1)
check('the inventory route reports missing creation times as null', result.payload.sessions[1].createdAt === null)
check('the inventory route reports parent and origin', result.payload.sessions[0].parentId === 'session-root' && result.payload.sessions[0].origin === 'subagent')

result = await call(inventory, makeRequest({ method: 'POST' }))
check('the inventory route refuses POST', result.response.status === 405 && result.response.headers.allow === 'GET')

/* ------------------------------------------------------------------ fence */

services.set('connection', { requestRejection: () => 401 })
result = await call(purge, makeRequest({ body: JSON.stringify({ sessionId: 'session-manager-test' }) }))
check('the request fence runs before the body', result.response.status === 401 && result.payload.error === 'refused', String(result.response.status))
result = await call(cacheUpkeep, makeRequest({ body: '{}' }))
check('the fence also guards housekeeping', result.response.status === 401 && result.payload.error === 'refused', String(result.response.status))
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

result = await call(purge, makeRequest({ body: JSON.stringify({ sessionId: 'session-manager-test' }) }))
check('the purge answers 200', result.response.status === 200 && result.payload.ok === true, JSON.stringify(result.payload))
check('the purge stops activity first', registryCalls[0] === 'stop:session-manager-test', JSON.stringify(registryCalls))
check('the purge drops every workspace membership', detached.length === 2, JSON.stringify(detached))
check('the purge clears archive and pin ids', registryCalls.includes('unarchive:session-manager-test') && registryCalls.includes('unpin:session-manager-test'))
check('the purge releases the live Session', released === 'session-manager-test', String(released))
check('the purge reports the stopped and released flags', result.payload.stopped === true && result.payload.released === true)
check('the purge deletes the projection cache', cacheDeletes.length === 1 && cacheDeletes[0] === 'session-manager-test')
check('the purge removed the target directory', !existsSync(target) && existsSync(kept))
check('the purge reports the removed directory', Array.isArray(result.payload.directories) && result.payload.directories.length === 1)

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

// A Host without a projection-cache table cannot sweep the cache: it says so.
services.delete('sessionProjectionCache')
result = await call(cacheUpkeep, makeRequest({ body: '{}' }))
check('cache housekeeping reports an unavailable cache', result.response.status === 200 && result.payload.skipped === 'projection-cache-unavailable', JSON.stringify(result.payload))

services.set('sessionProjectionCache', { table: { keys() { throw new Error('table offline') }, async delete() { return false } } })
result = await call(cacheUpkeep, makeRequest({ body: '{}' }))
check('cache housekeeping reports an unreadable cache', result.response.status === 200 && result.payload.skipped === 'projection-cache-unreadable', JSON.stringify(result.payload))

// A real fault is a 500, not a crash.
services.set('sessionProjectionCache', { table: cacheTable })
const realGet = ctx.get
ctx.get = (key) => {
  if (key === 'sessionProjectionCache') throw new Error('boom')
  return realGet(key)
}
result = await call(cacheUpkeep, makeRequest({ body: '{}' }))
check('a housekeeping failure is a 500', result.response.status === 500 && result.payload.error === 'upkeep-failed', JSON.stringify(result.payload))
ctx.get = realGet

// An inventory failure is reported, not thrown.
services.set('sessionQuery', { async listSessions() { throw new Error('index offline') } })
result = await call(inventory, makeRequest({ method: 'GET' }))
check('an inventory failure is reported', result.response.status === 500 && result.payload.error === 'inventory-failed')

await rm(base, { recursive: true, force: true })

check('the temporary DSH_HOME is cleaned up', !existsSync(base))

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}

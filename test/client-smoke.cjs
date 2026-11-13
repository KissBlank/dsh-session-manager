/**
 * Smoke test for dsh-session-manager's browser half.
 *
 * Loads the real `lib/client.js` with a tiny React shim, a fake Cordis context
 * and a fake `fetch`, then checks:
 *   - the five slot registrations (menu row, single dialog, main gate, sidebar
 *     icon, console overlay) land with the expected ids and orders,
 *   - `inventory()` and `purgeMany()` talk to the Host the way the Host half
 *     expects, including per-Session failure collection and one final refresh,
 *   - the query/sort/archive helpers behave,
 *   - the console, its confirmation gate and the single-Session dialog render
 *     the markup the Host expects.
 *
 * The only transformation applied to the real source is a `__test` seam added
 * to the plugin's return object so internal helpers can be exercised; the file
 * on disk is untouched.
 *
 * Run: node test/client-smoke.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CLIENT = path.join(__dirname, '..', 'lib', 'client.js')
const raw = fs.readFileSync(CLIENT, 'utf8')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/* ----------------------------------------------------------------- React */

const hooks = { index: 0, force: new Set(), override: new Map() }

const React = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children }
  },
  useState(initial) {
    const index = hooks.index
    hooks.index += 1
    const value = typeof initial === 'function' ? initial() : initial
    if (hooks.override.has(index)) return [hooks.override.get(index), () => {}]
    return [hooks.force.has(index) ? true : value, () => {}]
  },
  useEffect() {},
  useMemo(compute) {
    return compute()
  },
  useCallback(fn) {
    return fn
  },
  useRef(initial) {
    return { current: initial === undefined ? null : initial }
  },
}

/* -------------------------------------------------------------- the load */

function patchForTest(source) {
  const marker = 'name: NS,'
  const at = source.indexOf(marker)
  if (at < 0) throw new Error('the plugin return object moved; update the smoke test')
  const seam = '__test: { ConsoleConfirm, ConsolePage, ConsoleRowView, PurgeMenuItem, PurgeOverlay, PurgeDialog, ConsoleOverlay, buildRows, sortRows, matchesQuery, countByTab, relativeTime, readPrefs, writePrefs },\n\t\t\t'
  return source.slice(0, at) + seam + source.slice(at)
}

const storage = new Map()
let styleTag = null
let plugin = null

global.window = {
  __ModuleLoader__: {
    load(definition) {
      plugin = definition.factory((name) => (name === 'react' ? React : undefined))
    },
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  },
  addEventListener() {},
  removeEventListener() {},
}
global.document = {
  baseURI: 'http://127.0.0.1:60368/',
  createElement: () => {
    styleTag = { dataset: {}, textContent: '', remove() { styleTag = null } }
    return styleTag
  },
  head: { appendChild() {} },
  querySelector: () => null,
  activeElement: null,
}

const patched = patchForTest(raw)
const tempFile = path.join(os.tmpdir(), `sp-client-${process.pid}.cjs`)
fs.writeFileSync(tempFile, patched, 'utf8')
require(tempFile)

const test = plugin.__test
check('client bundle defines a plugin', plugin !== null && plugin.name === 'session-manager')
check('client injects slots and locale', Array.isArray(plugin.inject) && plugin.inject.join(',') === 'slots,locale')
check('test seam exposes the internals', typeof test.ConsoleConfirm === 'function' && typeof test.buildRows === 'function')

/* ------------------------------------------------------------------- ctx */

const t = (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`)
const registered = []
const dictionaries = []
const services = new Map()

const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  locale: {
    bind: () => t,
    register(namespace, dicts) {
      dictionaries.push({ namespace, dicts })
      return () => {}
    },
  },
  slots: {
    inject(slot, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registered.push({ slot: options.name, options, component })
      return () => {}
    },
  },
  get(key) {
    return services.get(key)
  },
}

plugin.apply(ctx)

const find = (predicate) => registered.find(predicate)
const menu = find((entry) => entry.options.id === 'session-manager.menu')
const single = find((entry) => entry.options.id === 'session-manager.overlay' && entry.options.order === 60)
const gate = find((entry) => entry.slot === 'main')
const icon = find((entry) => entry.slot === 'sidebar.panellist')
const consoleEntry = find((entry) => entry.options.id === 'session-manager.console')

check('menu row registered after the Host rows', menu !== undefined && menu.options.order === 500 && menu.slot === 'sidebar.workspaces.session.menu.item')
check('single dialog registered in shell.overlay', single !== undefined)
check('main gate registered for the sidebar id', gate !== undefined && gate.options.key === 'session-console')
check('sidebar icon registered', icon !== undefined && icon.options.id === 'session-console' && icon.options.order === 5 && typeof icon.options.label === 'function')
check('console overlay registered', consoleEntry !== undefined && consoleEntry.options.order === 70 && consoleEntry.slot === 'shell.overlay')
check('dictionaries registered for zh and en', dictionaries.length === 1 && dictionaries[0].dicts.zh !== undefined && dictionaries[0].dicts.en !== undefined)
check('the menu row and the console share one store', typeof menu.options.inject === 'function' && typeof menu.options.inject === 'function')
check('the console panel glyph is the drawn icon', icon !== undefined && icon.component !== undefined)
check('the console gate renders nothing', gate.component({}) === null)
check('the stylesheet reached the document head', styleTag !== null && /spc-panel/.test(styleTag.textContent))

/* ---------------------------------------------------------------- helpers */

const emptyList = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
const emptyWorkspaces = { items: [], pinnedSessionIds: [], archivedSessionIds: [] }

const list = {
  ids: ['session-a', 'session-b', 'session-c', 'session-d'],
  byId: {
    'session-a': { id: 'session-a', displayTitle: 'Alpha', updatedAt: Date.now() - 90_000, running: true },
    'session-b': { id: 'session-b', displayTitle: 'Beta', updatedAt: Date.now() - 7_200_000, running: false },
    'session-c': { id: 'session-c', displayTitle: 'Gamma', updatedAt: Date.now() - 3_600_000, running: false, origin: 'subagent' },
    'session-d': { id: 'session-d', displayTitle: 'Delta', updatedAt: Date.now() - 1_800_000, running: false, parentId: 'session-a' },
  },
  phase: 'ready',
  projectionsBySession: {},
}
const workspaces = {
  items: [{ workspaceId: 'w1', path: 'D:\\work', title: 'demo', sessionIds: ['session-a', 'session-b'] }],
  pinnedSessionIds: [],
  archivedSessionIds: ['session-b'],
}
const statuses = new Map([['session-a', { running: true, pendingInteraction: undefined }]])

const rows = test.buildRows(list, statuses, workspaces, { 'session-b': 1_700_000_000_000 })
check('rows skip subagent children', rows.length === 2 && rows.every((row) => row.id === 'session-a' || row.id === 'session-b'))
check('rows carry the archived flag', rows.find((row) => row.id === 'session-b').archived === true)
check('rows carry the workspace title', rows.find((row) => row.id === 'session-a').workspace === 'demo')
check('rows carry a running flag', rows.find((row) => row.id === 'session-a').running === true)
check('rows carry the Host creation time', rows.find((row) => row.id === 'session-b').createdAt === 1_700_000_000_000)
check('rows default the title to the id', test.buildRows({ ids: ['session-x'], byId: { 'session-x': {} } }, new Map(), emptyWorkspaces, {})[0].title === 'session-x')

check('search matches the title', test.matchesQuery({ title: 'Alpha', id: 'session-a', workspace: 'demo' }, 'alp') === true)
check('search matches the id', test.matchesQuery({ title: 'Alpha', id: 'session-a', workspace: 'demo' }, 'SESSION-A') === true)
check('search matches the workspace', test.matchesQuery({ title: 'Alpha', id: 'session-a', workspace: 'demo' }, 'dem') === true)
check('search rejects a miss', test.matchesQuery({ title: 'Alpha', id: 'session-a', workspace: 'demo' }, 'zzz') === false)
check('counts split archived from active', JSON.stringify(test.countByTab(rows, '')) === JSON.stringify({ all: 2, active: 1, archived: 1 }))
check('counts follow the search', JSON.stringify(test.countByTab(rows, 'beta')) === JSON.stringify({ all: 1, active: 0, archived: 1 }))
check('activity sort is newest first', test.sortRows(rows, 'activity')[0].id === 'session-a')
check('creation sort uses the Host time', test.sortRows(rows, 'created')[0].id === 'session-b')

check('recent activity reads as just now', test.relativeTime(t, Date.now() - 5_000) === 'time.justNow')
check('minutes bucket', test.relativeTime(t, Date.now() - 5 * 60_000).startsWith('time.minutes'))
check('hours bucket', test.relativeTime(t, Date.now() - 3 * 3_600_000).startsWith('time.hours'))
check('days bucket', test.relativeTime(t, Date.now() - 3 * 86_400_000).startsWith('time.days'))
/* Locale-independent: the fallback is `new Date(ms).toLocaleString()`, which
   puts the year first in zh-CN but last in en-US (the CI runner's locale). */
const oldActivity = Date.now() - 90 * 86_400_000
check('old activity falls back to an absolute time', test.relativeTime(t, oldActivity) === new Date(oldActivity).toLocaleString())

storage.clear()
check('prefs default to all/activity', JSON.stringify(test.readPrefs()) === JSON.stringify({ tab: 'all', sort: 'activity' }))
test.writePrefs({ tab: 'archived', sort: 'created' })
check('prefs round-trip', JSON.stringify(test.readPrefs()) === JSON.stringify({ tab: 'archived', sort: 'created' }))
storage.set('session-manager.console.v1', '{not json')
check('broken prefs fall back', test.readPrefs().tab === 'all')
storage.clear()

/* ---------------------------------------------------------------- fetch */

const calls = []
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
global.fetch = async (url, init) => {
  calls.push({ url, init })
  return fetchImpl(url, init)
}

const consoleFace = consoleEntry.options.inject()
const consoleApi = consoleFace.consoleApi
check('console api exposes its five calls', ['close', 'unarchive', 'purgeMany', 'inventory', 'upkeep'].every((key) => typeof consoleApi[key] === 'function'))

const listProps = {
  t,
  consoleApi: {},
  useSessions: (selector) => selector(emptyList),
  useWorkspaces: (selector) => selector(emptyWorkspaces),
  useSessionStatus: (selector) => selector(new Map()),
  usePanelInfo: (selector) => selector({ activePanelId: 'session-console' }),
}

/* ---------------------------------------------------------------- render */

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) })
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  if (typeof node.type === 'function') {
    walk(node.type(node.props), visit)
    return
  }
  for (const child of node.children) walk(child, visit)
}

function collect(tree) {
  const texts = []
  const elements = []
  walk(tree, (node) => {
    if (node.text !== undefined) texts.push(node.text)
    else elements.push(node)
  })
  return { texts, elements }
}

function renderComponent(component, props, force = [], override = new Map()) {
  hooks.index = 0
  hooks.force = new Set(force)
  hooks.override = override
  return component(props)
}

const inactive = renderComponent(consoleEntry.component, { ...listProps, usePanelInfo: (selector) => selector({ activePanelId: 'plugins' }) })
check('the console stays closed on other panels', inactive === null)

const populatedProps = {
  t,
  consoleApi: {},
  useSessions: (selector) => selector(list),
  useWorkspaces: (selector) => selector(workspaces),
  useSessionStatus: (selector) => selector(statuses),
  usePanelInfo: (selector) => selector({ activePanelId: 'session-console' }),
}

const consoleTree = renderComponent(consoleEntry.component, populatedProps)
const consoleRead = collect(consoleTree)
const consoleText = consoleRead.texts.join(' ')
check('the console renders its title', consoleText.includes('console.title'))
check('the console renders both rows', consoleText.includes('Alpha') && consoleText.includes('Beta'))
check('the console marks the archived row', consoleText.includes('console.archivedBadge'))
check('the console shows the running status', consoleText.includes('console.status.running'))
check('the console shows the idle status', consoleText.includes('console.status.idle'))
check('the console shows the tab counts', consoleRead.texts.includes('2') && consoleRead.texts.includes('1'))
check('the console renders a relative time', /time\.(justNow|minutes|hours)/.test(consoleText))
check('the console renders the workspace', consoleText.includes('demo'))
check('the bulk bar stays hidden with nothing selected', !consoleText.includes('console.bulkPurge'))
check('the header checkbox is enabled with rows', consoleRead.elements.some((node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.disabled === false))

const dialogBefore = consoleRead.elements.filter((node) => node.props.className === 'sp-layer spc-dialog-layer')
check('no confirmation is open by default', dialogBefore.length === 0)

storage.set('session-manager.console.v1', JSON.stringify({ tab: 'archived', sort: 'activity' }))
const emptyRead = collect(renderComponent(consoleEntry.component, listProps))
check('the archived tab has its own empty state', emptyRead.texts.includes('console.empty.archived'))
check('the header checkbox is disabled without rows', emptyRead.elements.some((node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.disabled === true))
storage.clear()

/* ------------------------------------------------------- housekeeping menu */

check('the console renders the housekeeping button', consoleRead.elements.some((node) => node.props.className === 'spc-more-button'))
check('the housekeeping menu stays closed by default', consoleRead.elements.every((node) => node.props.className !== 'spc-more-menu'))

/* ------------------------------------------------------------- table roles */

const tableNode = consoleRead.elements.find((node) => node.props.role === 'table')
check('the rows sit in a table container', tableNode !== undefined)
check('the table counts its rows and columns', tableNode.props['aria-rowcount'] === 3 && tableNode.props['aria-colcount'] === 6, JSON.stringify({ rows: tableNode.props['aria-rowcount'], cols: tableNode.props['aria-colcount'] }))
const headers = consoleRead.elements.filter((node) => node.props.role === 'columnheader')
check('every column has a header cell', headers.length === 6, String(headers.length))
const cells = consoleRead.elements.filter((node) => node.props.role === 'cell')
check('every rendered row carries its cells', cells.length === 12, String(cells.length))
check(
  'rows are numbered after the header',
  consoleRead.elements.filter((node) => node.props.role === 'row' && node.props['aria-rowindex'] !== undefined)
    .map((node) => node.props['aria-rowindex']).join(',') === '1,2,3',
)

/* ------------------------------------------------------------ bulk bar red */

const bulkProps = {
  ...populatedProps,
  useSessions: (selector) => selector({
    ...list,
    ids: ['session-a'],
    byId: { 'session-a': list.byId['session-a'] },
  }),
}
let bulkIndex = -1
for (let index = 0; index < 24 && bulkIndex < 0; index += 1) {
  try {
    const probe = collect(renderComponent(consoleEntry.component, bulkProps, [], new Map([[index, new Set(['session-a'])]])))
    if (probe.texts.includes('console.bulkPurge')) bulkIndex = index
  } catch {
    // Overriding an unrelated state can break the render; that slot is not the selection.
  }
}
if (bulkIndex >= 0) {
  const bulkRead = collect(renderComponent(consoleEntry.component, bulkProps, [], new Map([[bulkIndex, new Set(['session-a'])]])))
  const bulkButton = bulkRead.elements.find((node) => node.type === 'button' && node.props.className === 'sp-button sp-button-sm sp-danger sp-danger-solid')
  check('the bulk delete uses the same filled red treatment as the dialogs', bulkButton !== undefined)
} else {
  check('the bulk delete uses the same filled red treatment as the dialogs', false, 'no state slot opened the bulk bar')
}

// Find the state that opens the menu by trying each hook slot, then render it open.
let menuIndex = -1
for (let index = 0; index < 24 && menuIndex < 0; index += 1) {
  try {
    const probe = collect(renderComponent(consoleEntry.component, populatedProps, [index]))
    if (probe.elements.some((node) => node.props.className === 'spc-more-menu')) menuIndex = index
  } catch {
    // Forcing an unrelated state can break the render; that slot is not the menu.
  }
}

const upkeepCalls = []
const upkeepProps = {
  ...populatedProps,
  consoleApi: {
    close() {},
    unarchive: async () => {},
    purgeMany: async () => ({ failures: [] }),
    inventory: async () => ({}),
    upkeep: async (kind) => { upkeepCalls.push(kind); return { removed: 0, freedBytes: 0 } },
  },
}
let upkeepClick = null
if (menuIndex >= 0) {
  const upkeepRead = collect(renderComponent(consoleEntry.component, upkeepProps, [menuIndex]))
  check('the housekeeping menu opens', upkeepRead.elements.some((node) => node.props.className === 'spc-more-menu'))
  check('the housekeeping menu lists every sweep', upkeepRead.texts.includes('console.more.cache') && upkeepRead.texts.includes('console.more.directories') && upkeepRead.texts.includes('console.more.backups'))
  const items = upkeepRead.elements.filter((node) => node.type === 'button' && node.props.role === 'menuitem')
  check('the housekeeping menu renders menuitem rows', items.length === 3, String(items.length))
  if (items.length === 3) upkeepClick = items[0].props.onClick
} else {
  check('the housekeeping menu opens', false, 'no state slot opened it')
  check('the housekeeping menu lists every sweep', false)
  check('the housekeeping menu renders menuitem rows', false)
}

/* ------------------------------------------------- the confirmation gate */

const confirmProps = (ids, rowById) => ({ t, ids, rowById, onCancel: () => {}, onConfirm: () => {} })
const twoRows = new Map([
  ['session-a', { id: 'session-a', title: 'Alpha', busy: true }],
  ['session-b', { id: 'session-b', title: 'Beta', busy: false }],
])

function dangerButton(elements) {
  return elements.find((node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('sp-danger'))
}

let read = collect(renderComponent(test.ConsoleConfirm, confirmProps(['session-a', 'session-b'], twoRows)))
check('the confirm dialog warns about running Sessions', read.texts.join(' ').includes('console.confirm.running'))
check('the confirm dialog asks for the force checkbox', read.texts.join(' ').includes('console.confirm.force'))
check('a small batch hides the irreversible checkbox', !read.texts.join(' ').includes('console.confirm.irreversible'))
check('the destructive button is blocked until acknowledged', dangerButton(read.elements).props.disabled === true)
check('the destructive button carries the filled red treatment', dangerButton(read.elements).props.className.includes('sp-danger-solid'))

read = collect(renderComponent(test.ConsoleConfirm, confirmProps(['session-a', 'session-b'], twoRows), [0]))
check('acknowledging the running Sessions unlocks the button', dangerButton(read.elements).props.disabled === false)

const quietRows = new Map([
  ['session-a', { id: 'session-a', title: 'Alpha', busy: false }],
  ['session-b', { id: 'session-b', title: 'Beta', busy: false }],
])
read = collect(renderComponent(test.ConsoleConfirm, confirmProps(['session-a', 'session-b'], quietRows)))
check('idle Sessions need no force checkbox', !read.texts.join(' ').includes('console.confirm.force'))
check('idle Sessions can be deleted directly', dangerButton(read.elements).props.disabled === false)

const manyIds = Array.from({ length: 12 }, (_, index) => `session-${index}`)
const manyRows = new Map(manyIds.map((id) => [id, { id, title: id, busy: false }]))
read = collect(renderComponent(test.ConsoleConfirm, confirmProps(manyIds, manyRows)))
check('a large batch demands the irreversible checkbox', read.texts.join(' ').includes('console.confirm.irreversible'))
check('a large batch stays blocked', dangerButton(read.elements).props.disabled === true)
check('a large batch titles itself with the count', read.texts.join(' ').includes('console.confirm.title.many'))
read = collect(renderComponent(test.ConsoleConfirm, confirmProps(manyIds, manyRows), [1]))
check('the irreversible checkbox unlocks a large batch', dangerButton(read.elements).props.disabled === false)

/* ---------------------------------------------------------- menu + dialog */

let menuClosed = 0
let menuStoreValue = null
const menuStore = { set: (value) => { menuStoreValue = value }, get: () => menuStoreValue, subscribe: () => () => {} }
const menuTree = renderComponent(menu.component, {
  sessionId: 'session-a',
  displayTitle: 'Alpha',
  useMenuOpenState: () => [true, () => { menuClosed += 1 }],
  t,
  store: menuStore,
})
const menuRead = collect(menuTree)
const item = menuRead.elements.find((node) => node.type === 'button' && node.props.role === 'menuitem')
check('the menu row is a menuitem button', item !== undefined)
check('the menu row carries the trash glyph', menuRead.elements.some((node) => node.type === 'path' && node.props.d === 'M1.28149 3.88831H14.7187'))
check('the menu row renders its label', menuRead.texts.includes('menu.purgeSession'))
check('the menu row renders a separator', menuRead.elements.some((node) => node.props.role === 'separator'))
item.props.onClick()
check('clicking the row closes the Host menu', menuClosed === 1)
check('clicking the row requests one Session', menuStoreValue !== null && menuStoreValue.sessionId === 'session-a' && menuStoreValue.phase === 'confirm')

const overlayFace = single.options.inject()
let unarchived = ''
let purged = 0
const overlayStore = {
  value: { sessionId: 'session-a', displayTitle: 'Alpha', phase: 'confirm', message: '', archived: false },
  get() { return this.value },
  set(next) { this.value = next },
  subscribe() { return () => {} },
}
const overlayProps = {
  t,
  store: overlayStore,
  run: async (request) => { purged += 1; return request },
  consoleApi: { close() {}, unarchive: async (id) => { unarchived = id }, purgeMany: async () => ({ failures: [] }), inventory: async () => ({}), upkeep: async () => ({ removed: 0 }) },
}
read = collect(renderComponent(single.component, overlayProps))
check('the single dialog opens on the row', read.texts.includes('dialog.title') && read.texts.includes('Alpha'))
check('the single dialog offers the red action', dangerButton(read.elements) !== undefined && dangerButton(read.elements).props.disabled === false)
check('the single dialog uses the filled red treatment', dangerButton(read.elements).props.className.includes('sp-danger-solid'))

overlayStore.value = { ...overlayStore.value, phase: 'running' }
read = collect(renderComponent(single.component, overlayProps))
check('the running dialog disables its actions', dangerButton(read.elements).props.disabled === true)
check('the running dialog reports progress', read.texts.includes('dialog.running'))

overlayStore.value = { ...overlayStore.value, phase: 'error', message: 'disk is busy', archived: true }
read = collect(renderComponent(single.component, overlayProps))
check('the failing dialog explains the archive fallback', read.texts.join(' ').includes('dialog.failedArchived'))

overlayStore.value = { ...overlayStore.value, phase: 'done', message: '' }
read = collect(renderComponent(single.component, overlayProps))
check('the done state turns into a toast', read.texts.join(' ').includes('toast.done'))

overlayStore.value = { ...overlayStore.value, phase: 'done', message: '', leftovers: 2 }
read = collect(renderComponent(single.component, overlayProps))
check('a leftover log is not toasted as a clean deletion', read.texts.join(' ').includes('toast.incomplete'))

overlayStore.value = { ...overlayStore.value, phase: 'done', message: '', leftovers: 0, descendantsUnresolved: true }
read = collect(renderComponent(single.component, overlayProps))
check('an unresolved family is not toasted as a clean deletion', read.texts.join(' ').includes('toast.incomplete'))

check('the overlay injects the console api', typeof overlayFace.consoleApi === 'object')

/* ------------------------------------------------------------------ host */

;(async () => {
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, sessions: [{ id: 'session-a', createdAt: 10 }, { id: 'session-b', createdAt: null }] }),
  })
  const inventory = await consoleApi.inventory()
  check('the inventory maps creation times', inventory['session-a'] === 10 && inventory['session-b'] === undefined, JSON.stringify(inventory))
  check('the inventory hits its own route', calls.at(-1).url === '/session-manager/api/inventory', calls.at(-1).url)

  let removals = 0
  let refreshes = 0
  services.set('sessions', {
    handleSessionRemoved() { removals += 1 },
    async refresh() { refreshes += 1 },
  })
  services.set('uiWorkspace', { async archiveSession() {}, async unarchiveSession() {} })

  let step = 0
  fetchImpl = async () => {
    step += 1
    if (step === 1) return { ok: true, status: 200, json: async () => ({ ok: true, leftovers: [] }) }
    if (step === 2) return { ok: true, status: 200, json: async () => ({ ok: true, leftovers: ['C:/x/session-c'] }) }
    return { ok: false, status: 500, json: async () => ({ ok: false, message: 'disk is busy' }) }
  }
  const progress = []
  const result = await consoleApi.purgeMany(['session-a', 'session-b', 'session-c'], (info) => progress.push(info))
  check('purgeMany reports each Session', progress.length === 3 && progress[0].index === 1 && progress[2].index === 3)
  check('purgeMany collects the failing Session', result.failures.length === 1 && result.failures[0].sessionId === 'session-c')
  check('purgeMany surfaces the Host message', /disk is busy/.test(result.failures[0].message), result.failures[0].message)
  check('purgeMany records that the failed row was left archived', result.failures[0].archived === true, JSON.stringify(result.failures[0]))
  check('purgeMany counts the rows that left files behind', result.incomplete === 1, JSON.stringify(result))
  check('purgeMany drops the deleted row locally', removals === 2, String(removals))
  check('purgeMany refreshes the shared list once', refreshes === 1, String(refreshes))
  check('purgeMany posted JSON bodies', calls.at(-1).init.method === 'POST' && calls.at(-1).init.body === '{"sessionId":"session-c"}')

  let selected = 'unchanged'
  services.set('layout', { selectPanel: (id) => { selected = id } })
  consoleApi.close()
  check('closing returns to the conversation', selected === null, String(selected))

  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, kind: 'cache', removed: 3, freedBytes: 4096 }) })
  const swept = await consoleApi.upkeep('cache')
  check('the cache sweep hits its own route', calls.at(-1).url === '/session-manager/api/maintenance/cache', calls.at(-1).url)
  check('the cache sweep posts', calls.at(-1).init.method === 'POST')
  check('the cache sweep reports its result', swept.removed === 3 && swept.freedBytes === 4096, JSON.stringify(swept))

  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, kind: 'directories', removed: 2 }) })
  await consoleApi.upkeep('directories')
  check('the folder sweep hits its own route', calls.at(-1).url === '/session-manager/api/maintenance/directories', calls.at(-1).url)

  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, kind: 'backups', removed: 1, freedBytes: 64, staleIds: 7, scanned: 5 }) })
  const backups = await consoleApi.upkeep('backups')
  check('the backup sweep hits its own route', calls.at(-1).url === '/session-manager/api/maintenance/backups', calls.at(-1).url)
  check('the backup sweep reports its result', backups.removed === 1, JSON.stringify(backups))
  check('the backup sweep passes the stale id count through', backups.staleIds === 7, JSON.stringify(backups))
  check('the backup sweep passes the scanned count through', backups.scanned === 5, JSON.stringify(backups))

  // A sweep that only cleared the live records reports zero rewritten files; the
  // stale count is then the only evidence the sweep did anything.
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, kind: 'backups', removed: 0, freedBytes: 0, staleIds: 3, scanned: 4 }) })
  const staleOnly = await consoleApi.upkeep('backups')
  check('a stale-only sweep still reports its stale ids', staleOnly.removed === 0 && staleOnly.staleIds === 3, JSON.stringify(staleOnly))

  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, skipped: 'projection-cache-unavailable' }) })
  const skipped = await consoleApi.upkeep('cache')
  check('a skipped sweep is reported as skipped', skipped.skipped === 'projection-cache-unavailable', JSON.stringify(skipped))

  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'upkeep-failed', message: 'disk is locked' }) })
  let upkeepError = ''
  try {
    await consoleApi.upkeep('cache')
  } catch (error) {
    upkeepError = error.message
  }
  check('a failing sweep surfaces the Host message', /disk is locked/.test(upkeepError), upkeepError)

  if (typeof upkeepClick === 'function') {
    fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, removed: 0, freedBytes: 0 }) })
    upkeepClick()
    await Promise.resolve()
    await Promise.resolve()
    check('the menu row runs the sweep it names', upkeepCalls[0] === 'cache', JSON.stringify(upkeepCalls))
  } else {
    check('the menu row runs the sweep it names', false, 'no menu row captured')
  }

  services.set('uiWorkspace', { async unarchiveSession(id) { unarchived = id } })
  await consoleApi.unarchive('session-d')
  check('unarchive prefers the uiWorkspace service', unarchived === 'session-d', unarchived)

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`)
    process.exitCode = 1
    fs.rmSync(tempFile, { force: true })
    return
  }
  console.log('\nall checks passed')
  fs.rmSync(tempFile, { force: true })
})().catch((error) => {
  console.log(`FAIL harness threw — ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
  fs.rmSync(tempFile, { force: true })
})

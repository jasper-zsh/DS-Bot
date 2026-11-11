import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { listedOpener } from '../src/client/open-listed.js'
import { createSource } from '../src/client/sources.js'
import { readReturnSession, writeReturnSession } from '../src/client/surface.js'
import { STORAGE } from '../src/client/storage.js'

const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
const home = source.slice(source.indexOf('  let stopBotHome ='), source.indexOf('  const actions ='))
const landing = source.slice(source.indexOf('    landOn: async'), source.indexOf('    selectPanel:'))
const switching = source.slice(source.indexOf('    setSurface: (mode)'), source.indexOf('    markUnread:'))

function storage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}

function rig(t, { mode = 'agent', current = 'native', ids = ['native', 'main', 'other'], saved = storage(), ready = true, pull = () => Promise.resolve(), remap = {} } = {}) {
  const list = createSource({ byId: Object.fromEntries(ids.map(id => [id, { id, ...(id === current ? { retainedBy: { mainView: 1 } } : {}) }])) })
  const mainView = () => Object.values(list.getSnapshot().byId).find(row => row.retainedBy?.mainView > 0)?.id
  const setMain = id => list.set(state => ({ byId: Object.fromEntries(Object.entries(state.byId).map(([key, row]) => [key, { ...row, retainedBy: key === id ? { mainView: 1 } : {} }])) }))
  const put = id => list.set(state => ({ byId: { ...state.byId, [id]: { id } } }))
  const surface = createSource({ mode, plain: false })
  const roster = createSource({ ready, mainBotId: 'main', byId: { main: { id: 'main' } }, roomsById: {} })
  const opened = []
  let refreshed = 0
  let plainCalls = 0
  const show = listedOpener({ list, current: mainView, refresh: () => { refreshed += 1 }, open: id => { opened.push([id, surface.getSnapshot().mode]); setMain(id) } })
  const disposers = []
  const context = {
    roster, surface, mainView, show, surfaceRevision: 0, returnSession: readReturnSession(saved),
    ctx: { effect: setup => disposers.push(setup()), layout: { toggleSidebar() {} } },
    frame: createSource({ collapsed: false }), ui: createSource({}), window: { innerWidth: 1280 }, DSH_NARROW: 1024,
    writeMode() {}, writeReturnSession: id => writeReturnSession(id, saved), pull,
    setPlain: plain => { plainCalls += 1; surface.set(state => ({ ...state, plain })) },
    currentPart: bot => bot.sessionId ?? bot.id, partFor: id => remap[id] ?? id,
  }
  const actions = runInNewContext(`${home}\nconst actions = {${landing}${switching}openSession: id => show(partFor(id))}; actions`, context)
  t.after(() => { disposers.forEach(dispose => dispose()); show.cancel() })
  return { actions, list, put, setMain, surface, roster, mainView, opened, saved, context, refreshed: () => refreshed, plainCalls: () => plainCalls, show, dispose: () => disposers.forEach(dispose => dispose()) }
}

test('native → Bot → native returns to the exact original session after applying Agent mode', (t) => {
  const f = rig(t)
  f.actions.setSurface('bot')
  assert.equal(f.saved.getItem(STORAGE.surfaceReturn), 'native')
  assert.equal(f.mainView(), 'main')
  f.actions.setSurface('agent')
  assert.deepEqual(f.opened, [['main', 'bot'], ['native', 'agent']])
  assert.equal(f.mainView(), 'native')
})

test('each native visit updates the bookmark, but repeated same-mode recovery does not', (t) => {
  const f = rig(t)
  f.actions.setSurface('bot')
  f.actions.setSurface('bot')
  assert.equal(f.saved.getItem(STORAGE.surfaceReturn), 'native')
  f.actions.setSurface('agent')
  f.setMain('other')
  f.actions.setSurface('bot')
  f.actions.setSurface('agent')
  assert.equal(f.mainView(), 'other')
  assert.equal(f.saved.getItem(STORAGE.surfaceReturn), 'other')
})

test('the exact saved id bypasses Bot part remapping and requires no workspace lookup', (t) => {
  const f = rig(t, { current: 'old-part', ids: ['old-part', 'new-part', 'main'], remap: { 'old-part': 'new-part' } })
  f.actions.setSurface('bot')
  f.actions.setSurface('agent')
  assert.equal(f.mainView(), 'old-part')
  assert.deepEqual(f.opened.at(-1), ['old-part', 'agent'])
})

test('entering Bot from an empty native view clears an older return bookmark', (t) => {
  const saved = storage()
  writeReturnSession('stale', saved)
  const f = rig(t, { current: null, saved })
  f.actions.setSurface('bot')
  f.actions.setSurface('agent')
  assert.equal(f.saved.getItem(STORAGE.surfaceReturn), null)
  assert.deepEqual(f.opened, [])
})

test('a Bot-mode page reload retains this tab\'s original native destination', (t) => {
  const saved = storage()
  const first = rig(t, { saved })
  first.actions.setSurface('bot')
  const reloaded = rig(t, { saved, mode: 'bot', current: 'main' })
  reloaded.actions.setSurface('agent')
  assert.deepEqual(reloaded.opened, [['native', 'agent']])
})

test('separate tab stores do not overwrite one another\'s destinations', (t) => {
  const a = rig(t)
  const b = rig(t, { current: 'other' })
  a.actions.setSurface('bot')
  b.actions.setSurface('bot')
  a.actions.setSurface('agent')
  b.actions.setSurface('agent')
  assert.equal(a.mainView(), 'native')
  assert.equal(b.mainView(), 'other')
})

test('denied browser storage still allows an in-memory round trip', (t) => {
  const saved = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
  const f = rig(t, { saved })
  assert.doesNotThrow(() => f.actions.setSurface('bot'))
  assert.doesNotThrow(() => f.actions.setSurface('agent'))
  assert.equal(f.mainView(), 'native')
})

test('returning while a Bot session is unlisted cancels its pending navigation even if current never changed', (t) => {
  const f = rig(t, { ids: ['native'] })
  f.actions.setSurface('bot')
  assert.equal(f.mainView(), 'native')
  f.actions.setSurface('agent')
  f.put('main')
  assert.deepEqual(f.opened, [['native', 'agent']])
})

test('missing bookmarks also cancel queued Bot navigation', (t) => {
  const f = rig(t, { current: null, ids: [] })
  f.actions.setSurface('bot')
  f.actions.landOn('main')
  f.actions.setSurface('agent')
  f.put('main')
  assert.deepEqual(f.opened, [])
})

test('a temporarily unlisted return session is opened only once it reaches the list', (t) => {
  const saved = storage()
  writeReturnSession('native', saved)
  const f = rig(t, { saved, mode: 'bot', current: 'main', ids: ['main'] })
  f.actions.setSurface('agent')
  assert.deepEqual(f.opened, [])
  assert.equal(f.refreshed(), 1)
  f.put('native')
  assert.deepEqual(f.opened, [['native', 'agent']])
})

test('a missing or deleted return session never opens a substitute or creates a session', (t) => {
  const saved = storage()
  writeReturnSession('deleted', saved)
  const f = rig(t, { saved, mode: 'bot', current: 'main' })
  f.actions.setSurface('agent')
  f.put('unrelated')
  assert.deepEqual(f.opened, [])
  assert.equal(f.surface.getSnapshot().mode, 'agent')
  assert.equal(f.mainView(), 'main')
})

test('a newer native navigation cancels a late return', (t) => {
  const saved = storage()
  writeReturnSession('native', saved)
  const f = rig(t, { saved, mode: 'bot', current: 'main', ids: ['main', 'other'] })
  f.actions.setSurface('agent')
  f.show('other')
  f.put('native')
  assert.deepEqual(f.opened, [['other', 'agent']])
})

test('a Bot landing awaiting a pull cannot steal the view after an Agent round trip', async (t) => {
  let finishPull
  const pull = () => new Promise(resolve => { finishPull = resolve })
  const saved = storage()
  writeReturnSession('native', saved)
  const f = rig(t, { mode: 'bot', current: 'main', saved, pull })
  const pending = f.actions.landOn('main', { botId: 'main', sessionId: 'old' })
  f.actions.setSurface('agent')
  f.actions.setSurface('bot')
  const before = f.opened.length
  const plain = f.plainCalls()
  finishPull()
  await pending
  assert.equal(f.opened.length, before)
  assert.equal(f.plainCalls(), plain)
})

test('plugin disposal also invalidates a Bot landing still awaiting its pull', async (t) => {
  let finishPull
  const f = rig(t, { mode: 'bot', current: 'main', pull: () => new Promise(resolve => { finishPull = resolve }) })
  const pending = f.actions.landOn('main', { botId: 'main', sessionId: 'old' })
  f.dispose()
  finishPull()
  await pending
  assert.deepEqual(f.opened, [])
  assert.equal(f.plainCalls(), 0)
})

test('old roster-ready callbacks cannot land across ABA mode changes', (t) => {
  const f = rig(t, { ready: false })
  f.actions.setSurface('bot')
  f.actions.setSurface('agent')
  f.actions.setSurface('bot')
  f.roster.set({ ...f.roster.getSnapshot(), ready: true })
  assert.deepEqual(f.opened, [['native', 'agent'], ['main', 'bot']])
})

test('return-session storage ignores empty or non-string values and clears explicitly', () => {
  for (const value of [null, '', '   ', 12, {}]) assert.equal(readReturnSession({ getItem: () => value }), null)
  const saved = storage()
  writeReturnSession('native', saved)
  assert.equal(readReturnSession(saved), 'native')
  writeReturnSession(null, saved)
  assert.equal(readReturnSession(saved), null)
})

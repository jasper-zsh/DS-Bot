import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { listedOpener } from '../src/client/open-listed.js'

const store = (ids = []) => {
  const listeners = new Set()
  const snapshot = { byId: {} }
  const notify = () => { for (const fn of listeners) fn() }
  const put = (id, main) => { snapshot.byId[id] = main ? { id, retainedBy: { mainView: 1 } } : { id } }
  for (const id of ids) put(id)
  return {
    getSnapshot: () => snapshot,
    listeners: () => [...listeners],
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set: (id) => { put(id); notify() },
    setMain: (id) => { for (const row of Object.values(snapshot.byId)) delete row.retainedBy; put(id, true); notify() },
  }
}

const mainViewOf = list => Object.values(list.getSnapshot().byId).find(row => (row?.retainedBy?.mainView ?? 0) > 0)?.id

const rig = (list) => {
  const opened = []
  let refreshes = 0
  const show = listedOpener({ list, open: id => opened.push(id), refresh: () => { refreshes += 1 }, current: () => mainViewOf(list) })
  return { show, opened, refreshes: () => refreshes }
}

test('a listed Session opens at once and no refresh is asked for', () => {
  const { show, opened, refreshes } = rig(store(['a']))
  show('a')
  assert.deepEqual(opened, ['a'])
  assert.equal(refreshes(), 0)
})

test('an unlisted Session opens when the list reaches it, only once', () => {
  const list = store()
  const { show, opened, refreshes } = rig(list)
  show('a')
  assert.deepEqual(opened, [])
  assert.equal(refreshes(), 1)
  list.set('a')
  assert.deepEqual(opened, ['a'])
  list.set('b')
  assert.deepEqual(opened, ['a'])
})

test('a newer navigation drops the wait for the old one', () => {
  const list = store(['b'])
  const { show, opened } = rig(list)
  show('a')
  show('b')
  assert.deepEqual(opened, ['b'])
  list.set('a')
  assert.deepEqual(opened, ['b'])
})

test('two waits in a row keep only the last one', () => {
  const list = store()
  const { show, opened } = rig(list)
  show('a')
  show('b')
  list.set('a')
  list.set('b')
  assert.deepEqual(opened, ['b'])
})

test('a navigation elsewhere drops the wait', () => {
  const list = store(['x'])
  list.setMain('x')
  const { show, opened } = rig(list)
  show('a')
  list.setMain('y')
  list.set('a')
  assert.deepEqual(opened, [])
})

test('cancellation invalidates callbacks already copied by a list dispatch', () => {
  const list = store()
  const { show, opened } = rig(list)
  show('a')
  const [stale] = list.listeners()
  show.cancel()
  assert.equal(list.listeners().length, 0)
  list.set('a')
  stale()
  assert.deepEqual(opened, [])
})

test('request guards apply before both immediate and delayed navigation', () => {
  const list = store(['a'])
  const { show, opened, refreshes } = rig(list)
  let allowed = false
  show('a', { valid: () => allowed })
  assert.deepEqual(opened, [])
  assert.equal(refreshes(), 0)
  allowed = true
  show('b', { valid: () => allowed })
  allowed = false
  list.set('b')
  assert.deepEqual(opened, [])
  assert.equal(list.listeners().length, 0)
})

test('a superseded callback cannot open its old target after another request', () => {
  const list = store()
  const { show, opened } = rig(list)
  show('a')
  const [stale] = list.listeners()
  show('b')
  list.set('a')
  stale()
  list.set('b')
  assert.deepEqual(opened, ['b'])
})

test('a timed-out restoration cannot navigate when a missing session appears later', async () => {
  const list = store()
  const { show, opened } = rig(list)
  show('a', { timeout: 10 })
  await pause(30)
  assert.equal(list.listeners().length, 0)
  list.set('a')
  assert.deepEqual(opened, [])
})

test('an old timeout cannot cancel a newer request', async () => {
  const list = store()
  const { show, opened } = rig(list)
  show('a', { timeout: 10 })
  show('b')
  await pause(30)
  list.set('b')
  assert.deepEqual(opened, ['b'])
})

test('prototype names are not mistaken for listed session ids', () => {
  const list = store()
  const { show, opened } = rig(list)
  show('toString')
  assert.deepEqual(opened, [])
  show.cancel()
})

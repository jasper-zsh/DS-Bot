import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'
import { floatingBounds, installFloatingToggle, readFloatingPosition } from '../src/client/floating-toggle.js'
import { STORAGE } from '../src/client/storage.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, 'dev/harness'), 'package.json'))('jsdom')

function fixture(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><button>DS Bot</button></body>', { url: 'https://test.invalid', pretendToBeVisual: true })
  const win = dom.window
  win.innerWidth = 800
  win.innerHeight = 600
  const node = win.document.querySelector('button')
  Object.defineProperties(node, { offsetWidth: { value: 140 }, offsetHeight: { value: 40 } })
  const point = () => {
    const [x, y] = node.style.translate.split(' ').map(parseFloat)
    return { x, y }
  }
  node.getBoundingClientRect = () => {
    const { x, y } = point()
    return { left: Number.isFinite(x) ? x : 644, top: Number.isFinite(y) ? y : 480, width: 140, height: 40 }
  }
  let captured
  node.setPointerCapture = id => { captured = id }
  node.hasPointerCapture = id => captured === id
  node.releasePointerCapture = () => { captured = undefined }
  const storage = options.storage ?? win.localStorage
  let blocks = []
  let reads = 0
  const off = installFloatingToggle(node, { window: win, storage, obstacles: () => { reads += 1; return blocks } })
  let clicks = 0
  node.addEventListener('click', () => { clicks += 1 })
  t.after(() => { off(); win.close() })
  const pointer = (type, x, y, id = 1, more = {}) => {
    const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...more })
    Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: more.isPrimary !== false } })
    const target = type === 'pointerdown' || type === 'lostpointercapture' ? node : win
    target.dispatchEvent(event)
    return event
  }
  const click = (detail = 1) => node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail }))
  const key = (name, shiftKey = true) => {
    const event = new win.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })
    node.dispatchEvent(event)
    return event
  }
  return { win, node, storage, off, point, pointer, click, key, clicks: () => clicks, reads: () => reads, blocks: value => { blocks = value } }
}

test('unmoved clicks and small pointer jitter still toggle normally', (t) => {
  const f = fixture(t)
  assert.deepEqual(f.point(), { x: 644, y: 480 })
  f.pointer('pointerdown', 700, 500)
  f.pointer('pointermove', 704, 501)
  f.pointer('pointerup', 704, 501)
  assert.equal(f.click(), true)
  assert.equal(f.clicks(), 1)
  assert.equal(f.storage.getItem(STORAGE.surfacePosition), null)
})

test('dragging moves the element and saves its position without switching modes', (t) => {
  const f = fixture(t)
  f.pointer('pointerdown', 700, 500)
  f.pointer('pointermove', 400, 280)
  assert.deepEqual(f.point(), { x: 344, y: 260 })
  assert.equal(f.node.hasAttribute('data-floating-dragging'), true)
  f.pointer('pointerup', 400, 280)
  assert.equal(f.node.hasAttribute('data-floating-dragging'), false)
  assert.equal(f.click(), false)
  assert.equal(f.clicks(), 0)
  assert.equal(f.click(), true, 'the following deliberate click is not swallowed')
  assert.equal(f.clicks(), 1)
  assert.deepEqual(readFloatingPosition(f.storage), { x: (344 - 16) / 628, y: (260 - 16) / 528 })
})

test('keyboard activation is preserved immediately after a drag', (t) => {
  const f = fixture(t)
  f.pointer('pointerdown', 700, 500)
  f.pointer('pointermove', 400, 280)
  f.pointer('pointerup', 400, 280)
  assert.equal(f.click(0), true)
  assert.equal(f.clicks(), 1)
})

test('a cancelled drag restores its origin and does not save a position', (t) => {
  const f = fixture(t)
  f.pointer('pointerdown', 700, 500)
  f.pointer('pointermove', 400, 280)
  f.pointer('pointercancel', 400, 280)
  assert.deepEqual(f.point(), { x: 644, y: 480 })
  assert.equal(f.storage.getItem(STORAGE.surfacePosition), null)
  assert.equal(f.click(), false)
})

test('lost capture and window blur cancel active gestures', (t) => {
  const f = fixture(t)
  for (const end of ['lostpointercapture', 'blur']) {
    f.pointer('pointerdown', 700, 500)
    f.pointer('pointermove', 400, 280)
    if (end === 'blur') f.win.dispatchEvent(new f.win.Event('blur'))
    else f.pointer(end, 400, 280)
    assert.deepEqual(f.point(), { x: 644, y: 480 })
    assert.equal(f.node.hasAttribute('data-floating-dragging'), false)
  }
})

test('other pointers and non-primary buttons cannot hijack a gesture', (t) => {
  const f = fixture(t)
  f.pointer('pointerdown', 700, 500, 2, { isPrimary: false })
  f.pointer('pointermove', 400, 280, 2)
  assert.deepEqual(f.point(), { x: 644, y: 480 })
  f.pointer('pointerdown', 700, 500, 1, { button: 2 })
  f.pointer('pointermove', 400, 280)
  assert.deepEqual(f.point(), { x: 644, y: 480 })
  f.pointer('pointerdown', 700, 500)
  f.pointer('pointermove', 100, 100, 2)
  f.pointer('pointerup', 100, 100, 2)
  f.pointer('pointermove', 400, 280)
  assert.deepEqual(f.point(), { x: 344, y: 260 })
})

test('a gesture can finish outside the element even when capture is unavailable', (t) => {
  const f = fixture(t)
  f.node.setPointerCapture = () => { throw new Error('not available') }
  f.pointer('pointerdown', 700, 500)
  f.pointer('pointermove', -500, -500)
  f.pointer('pointerup', -500, -500)
  assert.deepEqual(f.point(), { x: 16, y: 16 })
  assert.deepEqual(readFloatingPosition(f.storage), { x: 0, y: 0 })
})

test('Shift + arrows move and persist the control without toggling', (t) => {
  const f = fixture(t)
  f.node.focus()
  assert.equal(f.key('ArrowLeft').defaultPrevented, true)
  assert.deepEqual(f.point(), { x: 628, y: 480 })
  assert.equal(f.win.document.activeElement, f.node)
  f.key('ArrowUp')
  assert.deepEqual(f.point(), { x: 628, y: 464 })
  assert.equal(f.key('ArrowDown', false).defaultPrevented, false)
  assert.equal(f.key(' ').defaultPrevented, false)
  assert.equal(f.clicks(), 0)
  assert.ok(readFloatingPosition(f.storage))
})

test('resizing and keyboard viewport changes keep the control in the visible bounds', async (t) => {
  const f = fixture(t)
  f.pointer('pointerdown', 700, 500)
  f.pointer('pointermove', 5000, 5000)
  f.pointer('pointerup', 5000, 5000)
  assert.deepEqual(f.point(), { x: 644, y: 544 })
  const viewport = new f.win.EventTarget()
  Object.assign(viewport, { width: 400, height: 250, offsetLeft: 20, offsetTop: 100 })
  Object.defineProperty(f.win, 'visualViewport', { value: viewport })
  f.win.dispatchEvent(new f.win.Event('resize'))
  await pause(330)
  assert.deepEqual(f.point(), { x: 264, y: 294 })
})

test('safe-area insets contribute to all visible viewport edges', (t) => {
  const f = fixture(t)
  for (const [side, px] of [['left', 4], ['top', 20], ['right', 6], ['bottom', 30]]) f.node.style.setProperty(`--bt-float-safe-${side}`, `${px}px`)
  assert.deepEqual(floatingBounds(f.win, f.node), { left: 20, top: 36, right: 778, bottom: 554 })
})

test('new floating controls trigger avoidance and disappearance does not cause oscillation', async (t) => {
  const f = fixture(t)
  f.blocks([{ left: 640, top: 475, right: 790, bottom: 530 }])
  const other = f.win.document.createElement('button')
  f.win.document.body.append(other)
  await pause(330)
  const avoided = f.point()
  assert.notDeepEqual(avoided, { x: 644, y: 480 })
  assert.ok(avoided.y + 40 <= 467 || avoided.x + 140 <= 632 || avoided.y >= 538)
  f.blocks([])
  other.remove()
  await pause(330)
  assert.deepEqual(f.point(), avoided)
  assert.equal(f.storage.getItem(STORAGE.surfacePosition), null, 'automatic avoidance does not overwrite the user preference')
})

test('storage failure never prevents dragging or switching', (t) => {
  const f = fixture(t, { storage: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } } })
  f.pointer('pointerdown', 700, 500)
  f.pointer('pointermove', 400, 280)
  assert.doesNotThrow(() => f.pointer('pointerup', 400, 280))
  assert.deepEqual(f.point(), { x: 344, y: 260 })
  assert.equal(f.click(0), true)
})

test('saved positions are validated before use', () => {
  for (const value of ['oops', 'null', '{}', '{"version":1,"x":-1,"y":0}', '{"version":1,"x":"0.5","y":0}', '{"version":2,"x":0,"y":0}']) {
    assert.equal(readFloatingPosition({ getItem: () => value }), null, value)
  }
  assert.deepEqual(readFloatingPosition({ getItem: () => '{"version":1,"x":0.25,"y":0.75}' }), { x: 0.25, y: 0.75 })
})

test('disposing removes timers, observers and input handlers and restores owned styles', async (t) => {
  const f = fixture(t)
  const before = f.reads()
  f.win.dispatchEvent(new f.win.Event('resize'))
  f.off()
  assert.equal(f.node.style.translate, '')
  f.pointer('pointerdown', 700, 500)
  f.pointer('pointermove', 400, 280)
  assert.equal(f.node.style.translate, '')
  await pause(330)
  assert.equal(f.reads(), before)
})

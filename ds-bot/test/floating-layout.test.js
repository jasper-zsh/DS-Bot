import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { clampPoint, floatingObstacles, placeFloating } from '../src/client/floating-layout.js'

const PLUGIN = resolve(import.meta.dirname, '..')
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, 'dev', 'harness'), 'package.json'))('jsdom')
const bounds = { left: 0, top: 0, right: 300, bottom: 200 }
const size = { width: 40, height: 30 }
const box = (left, top, right, bottom) => ({ left, top, right, bottom })
const collides = (point, obstacle, gap = 8, dimensions = size) => point.x < obstacle.right + gap && point.x + dimensions.width > obstacle.left - gap
  && point.y < obstacle.bottom + gap && point.y + dimensions.height > obstacle.top - gap

function page(html, visualViewport) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  const { window } = dom
  Object.defineProperties(window, { innerWidth: { value: 800 }, innerHeight: { value: 600 } })
  if (visualViewport) Object.defineProperty(window, 'visualViewport', { value: visualViewport })
  window.Element.prototype.getBoundingClientRect = function () {
    const [left = 0, top = 0, right = 0, bottom = 0] = (this.getAttribute('data-box') ?? '').split(',').filter(Boolean).map(Number)
    return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top }
  }
  return { dom, document: window.document, detect: (root = window.document, owner) => floatingObstacles(root, owner) }
}
const ordered = rects => [...rects].sort((a, b) => a.left - b.left || a.top - b.top)

for (const [point, expected] of [
  [{ x: 10, y: 20 }, { x: 10, y: 20 }],
  [{ x: -20, y: 300 }, { x: 0, y: 170 }],
  [{ x: 300, y: -20 }, { x: 260, y: 0 }],
]) {
  test(`clampPoint bounds ${point.x},${point.y}`, () => {
    assert.deepEqual(clampPoint(point, size, bounds), expected)
  })
}

test('clamping respects negative viewport origins and pins impossible dimensions to the near edge', () => {
  assert.deepEqual(clampPoint({ x: -100, y: -100 }, size, box(-60, -40, 240, 160)), { x: -60, y: -40 })
  assert.deepEqual(clampPoint({ x: 500, y: 500 }, size, box(-10, -20, 0, -10)), { x: -10, y: -20 })
  assert.deepEqual(clampPoint({ x: NaN, y: Infinity }, { width: 0, height: 0 }, bounds), { x: 0, y: 0 })
})

test('a free preference remains unchanged and no input is mutated', () => {
  const point = Object.freeze({ x: 10, y: 10 })
  const obstacle = Object.freeze(box(180, 100, 220, 140))
  assert.deepEqual(placeFloating(point, Object.freeze(size), Object.freeze(bounds), Object.freeze([obstacle])), point)
  assert.deepEqual(placeFloating({ x: 500, y: 500 }, size, bounds, []), { x: 260, y: 170 })
})

test('the nearest edge is chosen with the requested clearance', () => {
  const obstacle = box(100, 50, 160, 100)
  const placed = placeFloating({ x: 110, y: 60 }, size, bounds, [obstacle])
  assert.deepEqual(placed, { x: 110, y: 12 })
  assert.equal(collides(placed, obstacle), false)
  assert.deepEqual(placeFloating({ x: 110, y: 60 }, size, bounds, [obstacle], 0), { x: 110, y: 20 })
})

test('placement considers the obstacle union rather than repeatedly moving into its neighbor', () => {
  const obstacles = [box(80, 0, 130, 200), box(130, 0, 180, 200), box(180, 0, 230, 200)]
  const placed = placeFloating({ x: 130, y: 80 }, size, bounds, obstacles)
  assert.deepEqual(placed, { x: 32, y: 80 })
  assert.ok(obstacles.every(obstacle => !collides(placed, obstacle)))
})

test('both axes participate in a corridor formed by overlapping obstacles', () => {
  const obstacles = [box(0, 0, 140, 110), box(130, 0, 300, 50), box(190, 45, 300, 200)]
  const dimensions = { width: 20, height: 20 }
  const placed = placeFloating({ x: 100, y: 30 }, dimensions, bounds, obstacles)
  assert.deepEqual(placed, { x: 148, y: 58 })
  assert.ok(obstacles.every(obstacle => !collides(placed, obstacle, 8, dimensions)))
})

test('equal-distance choices are stable across obstacle order and duplicates', () => {
  const obstacles = [box(100, 60, 160, 120), box(220, 130, 250, 150)]
  const dimensions = { width: 40, height: 40 }
  const first = placeFloating({ x: 110, y: 70 }, dimensions, bounds, obstacles)
  assert.deepEqual(placeFloating({ x: 110, y: 70 }, dimensions, bounds, [...obstacles].reverse()), first)
  assert.deepEqual(placeFloating({ x: 110, y: 70 }, dimensions, bounds, [...obstacles, obstacles[0]]), first)
  assert.deepEqual(first, { x: 110, y: 12 })
})

test('the nearest valid point is measured from the requested point even outside bounds', () => {
  const dimensions = { width: 20, height: 20 }
  assert.deepEqual(placeFloating({ x: -100, y: 40 }, dimensions, box(0, 0, 100, 100), [box(0, 0, 10, 80)], 0), { x: 0, y: 80 })
})

test('a dense viewport chooses minimum overlap before distance instead of staying put', () => {
  const dimensions = { width: 60, height: 60 }
  const obstacles = [box(0, 0, 75, 100)]
  assert.deepEqual(placeFloating({ x: 0, y: 0 }, dimensions, box(0, 0, 100, 100), obstacles, 0), { x: 40, y: 0 })
})

test('a fully obstructed tiny viewport returns a bounded deterministic fallback', () => {
  const tiny = box(-20, -10, -10, 0)
  const obstacles = Array.from({ length: 100 }, (_, i) => box(-30 + i / 10, -20, 20 + i / 10, 20))
  assert.deepEqual(placeFloating({ x: 5, y: 5 }, size, tiny, obstacles), { x: -20, y: -10 })
  assert.deepEqual(placeFloating({ x: 5, y: 5 }, size, tiny, [...obstacles].reverse()), { x: -20, y: -10 })
})

test('invalid obstacles are ignored, and zero-sized controls need no avoidance', () => {
  assert.deepEqual(placeFloating({ x: 10, y: 10 }, size, bounds, [null, box(0, 0, NaN, 10), box(10, 10, 0, 0)]), { x: 10, y: 10 })
  assert.deepEqual(placeFloating({ x: 10, y: 10 }, { width: 0, height: 0 }, bounds, [box(0, 0, 100, 100)]), { x: 10, y: 10 })
})

test('100 chained controls still find a free edge without a relocation limit', () => {
  const obstacles = Array.from({ length: 100 }, (_, i) => box(100 + i * 5, 0, 130 + i * 5, 200))
  const placed = placeFloating({ x: 350, y: 80 }, size, box(0, 0, 800, 200), obstacles)
  assert.ok(obstacles.every(obstacle => !collides(placed, obstacle)))
  assert.deepEqual(placed, { x: 633, y: 80 })
})

test('candidate placement agrees with an exhaustive small integer-grid oracle', () => {
  const dimensions = { width: 6, height: 5 }
  const areaOf = (point, rect) => Math.max(0, Math.min(point.x + 6, rect.right) - Math.max(point.x, rect.left))
    * Math.max(0, Math.min(point.y + 5, rect.bottom) - Math.max(point.y, rect.top))
  let seed = 123
  const next = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max }
  for (let scenario = 0; scenario < 40; scenario += 1) {
    const target = { x: next(50) - 10, y: next(40) - 10 }
    const obstacles = Array.from({ length: 6 }, () => {
      const x = next(29)
      const y = next(21)
      return box(x, y, x + 3 + next(10), y + 3 + next(9))
    })
    const possibilities = []
    for (let x = 0; x <= 26; x += 1) for (let y = 0; y <= 19; y += 1) {
      const point = { x, y }
      possibilities.push({ point, area: obstacles.reduce((sum, rect) => sum + areaOf(point, rect), 0), away: (x - target.x) ** 2 + (y - target.y) ** 2 })
    }
    possibilities.sort((a, b) => a.area - b.area || a.away - b.away || a.point.y - b.point.y || a.point.x - b.point.x)
    assert.deepEqual(placeFloating(target, dimensions, box(0, 0, 32, 24), obstacles, 0), possibilities[0].point, `scenario ${scenario}`)
  }
})

test('finder recognizes native controls and compact fixed wrappers', () => {
  const { detect } = page(`
    <button style="position:fixed" data-box="10,20,50,60">A</button>
    <div style="position:fixed" data-box="100,20,280,100"><a href="#x" data-box="110,30,160,60">B</a></div>
    <input type="button" style="position:fixed" data-box="300,20,350,60">
    <span role="switch" style="position:fixed" data-box="400,20,450,60"></span>
    <span role="button" style="position:fixed" data-box="500,20,550,60"></span>`)
  assert.deepEqual(ordered(detect()), [box(10, 20, 50, 60), box(110, 30, 160, 60), box(300, 20, 350, 60), box(400, 20, 450, 60), box(500, 20, 550, 60)])
})

test('hinted pointer-only floating div launchers are detected without semantic roles', () => {
  const classes = ['floatingControl', 'floatControl', 'FloatingControl', 'FloatControl', 'fabControl', 'launcherControl', 'LauncherControl']
  const { detect } = page(`
    <style>[data-floating],#keyboard-launcher{position:fixed;cursor:pointer}</style>
    ${classes.map((name, i) => `<div class="${name}" data-floating data-box="${i * 70},20,${i * 70 + 40},60">Launch</div>`).join('')}
    <div id="keyboard-launcher" tabindex="0" data-box="500,20,540,60">Keyboard launcher</div>
    <div style="position:fixed;cursor:pointer" data-box="600,20,640,60">Inline launcher</div>`)
  assert.deepEqual(ordered(detect()), [...classes.map((_, i) => box(i * 70, 20, i * 70 + 40, 60)), box(500, 20, 540, 60), box(600, 20, 640, 60)])
})

test('pointer hints do not promote normal content, fixed labels or generic toolbar surfaces', () => {
  const { detect } = page(`
    <div class="floatingControl" style="cursor:pointer" data-box="10,10,50,50">Normal clickable content</div>
    <div class="launcherLabel" style="position:fixed" data-box="60,10,100,50">Fixed label</div>
    <div role="toolbar" class="floatingToolbar" style="position:fixed;cursor:pointer" data-box="110,10,250,70">Toolbar</div>
    <div class="floatingPanel" style="position:fixed;cursor:pointer" data-box="0,100,500,400">Large panel</div>
    <div role="dialog"><div class="floatingControl" style="position:fixed;cursor:pointer" data-box="300,10,340,50">Modal launcher</div></div>`)
  assert.deepEqual(detect(), [])
})

test('compact pointer wrappers can be obstacle surfaces and identical rectangles are deduplicated', () => {
  const { detect } = page(`
    <div class="floatingLauncher" style="position:fixed;cursor:pointer" data-box="10,10,70,70">
      <button data-box="10,10,70,70">Launch</button>
    </div>`)
  assert.deepEqual(detect(), [box(10, 10, 70, 70)])
})

test('pointer-only absolute launchers under transparent viewport overlays are included', () => {
  const { detect } = page(`
    <div style="position:fixed;pointer-events:none" data-box="0,0,800,600">
      <div class="floatingLauncher" style="position:absolute;cursor:pointer;pointer-events:auto" data-box="700,500,750,550">Launch</div>
    </div>`)
  assert.deepEqual(detect(), [box(700, 500, 750, 550)])
})

test('absolute controls in pointer-transparent viewport overlays are floating', () => {
  const { detect } = page(`
    <div style="position:fixed;pointer-events:none" data-box="0,0,800,600">
      <button style="position:absolute;pointer-events:auto" data-box="700,500,750,540">A</button>
      <div style="position:absolute;pointer-events:auto" data-box="500,500,650,550"><button data-box="510,510,550,540">B</button></div>
      <button data-box="30,30,70,70">Not independently placed</button>
    </div>`)
  assert.deepEqual(ordered(detect()), [box(510, 510, 550, 540), box(700, 500, 750, 540)])
})

test('ordinary page, scrolling content and large fixed toolbars or panels are not floating controls', () => {
  const { detect } = page(`
    <button data-box="10,10,50,40">Page</button>
    <div style="overflow:auto" data-box="0,100,700,500"><button data-box="10,110,50,150">Content</button></div>
    <div role="toolbar" style="position:fixed" data-box="0,0,800,70"><button data-box="80,10,120,50">Toolbar</button></div>
    <aside style="position:fixed" data-box="500,0,800,600"><button data-box="510,100,550,140">Panel</button>
      <button style="position:fixed" data-box="700,500,750,550">Independent</button>
    </aside>
    <div style="position:absolute" data-box="0,0,100,100"><button data-box="10,10,50,50">Document absolute</button></div>`)
  assert.deepEqual(detect(), [box(700, 500, 750, 550)])
})

test('large opaque panels under a transparent full-screen overlay do not become floating button groups', () => {
  const { detect } = page(`
    <div style="position:fixed;pointer-events:none" data-box="0,0,800,600">
      <div style="position:absolute;pointer-events:auto" data-box="0,0,600,500"><button data-box="10,10,50,50">Panel</button></div>
    </div>`)
  assert.deepEqual(detect(), [])
})

test('modal, menu and popover ancestry excludes even independent fixed controls', () => {
  const { detect } = page(['dialog open', 'div role="dialog"', 'div role="alertdialog"', 'div role="menu"', 'div role="menubar"', 'div aria-modal="true"', 'div popover'].map((tag, i) => {
    const end = tag.startsWith('dialog') ? 'dialog' : 'div'
    return `<${tag}><button style="position:fixed" data-box="${i * 60},10,${i * 60 + 40},50">Excluded</button></${end}>`
  }).join(''))
  assert.deepEqual(detect(), [])
})

test('hidden or noninteractive ancestors and controls are excluded', () => {
  const hidden = ['display:none', 'visibility:hidden', 'visibility:collapse', 'opacity:0', 'content-visibility:hidden']
  const { detect } = page(`
    ${hidden.map(style => `<div style="${style}"><button style="position:fixed" data-box="10,10,50,50">Hidden</button></div>`).join('')}
    <div hidden><button style="position:fixed" data-box="10,10,50,50">Hidden</button></div>
    <div aria-hidden="true"><button style="position:fixed" data-box="10,10,50,50">Hidden</button></div>
    <button disabled style="position:fixed" data-box="10,10,50,50">Disabled</button>
    <button style="position:fixed;pointer-events:none" data-box="10,10,50,50">Transparent</button>
    <button style="position:fixed" data-box="0,0,0,0">Zero</button>
    <button style="position:fixed" data-box="900,900,950,950">Offscreen</button>
    <button style="position:fixed" data-box="0,0,300,150">Large</button>`)
  assert.deepEqual(detect(), [])
})

test('the owner and its descendants are excluded without hiding a neighboring control', () => {
  const { detect, document } = page(`
    <div id="owner" style="position:fixed" data-box="10,10,200,100"><button style="position:fixed" data-box="20,20,60,60">Self</button></div>
    <button style="position:fixed" data-box="300,20,340,60">Other</button>`)
  assert.deepEqual(detect(document, document.getElementById('owner')), [box(300, 20, 340, 60)])
})

test('finder is root-scoped and includes the root when it is itself a control', () => {
  const { detect, document } = page(`
    <button id="root" style="position:fixed" data-box="10,10,50,50">A</button>
    <button style="position:fixed" data-box="100,10,140,50">B</button>`)
  assert.deepEqual(detect(document.getElementById('root')), [box(10, 10, 50, 50)])
})

test('open shadow controls are found and composed owner/hidden/modal ancestry is respected', () => {
  const { detect, document } = page('<div id="host"></div>')
  const host = document.getElementById('host')
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = '<button style="position:fixed" data-box="50,50,90,90">Shadow</button>'
  assert.deepEqual(detect(), [box(50, 50, 90, 90)])
  assert.deepEqual(detect(shadow), [box(50, 50, 90, 90)])
  assert.deepEqual(detect(document, host), [])
  host.style.opacity = '0'
  assert.deepEqual(detect(), [])
  host.style.opacity = '1'
  host.setAttribute('role', 'dialog')
  assert.deepEqual(detect(), [])
})

test('detector uses the visible viewport rectangle, including negative origins', () => {
  const { detect } = page(`
    <button style="position:fixed" data-box="-50,-30,-10,10">Visible</button>
    <button style="position:fixed" data-box="350,50,390,90">Outside visual view</button>`, { offsetLeft: -60, offsetTop: -40, width: 300, height: 200 })
  assert.deepEqual(detect(), [box(-50, -30, -10, 10)])
})

test('detector bounds measurements and output for large documents', () => {
  const { detect, document } = page(Array.from({ length: 700 }, (_, i) => `<button style="position:fixed" data-box="${i % 700},20,${i % 700 + 30},50">${i}</button>`).join(''))
  let reads = 0
  const original = document.defaultView.Element.prototype.getBoundingClientRect
  document.defaultView.Element.prototype.getBoundingClientRect = function () { reads += 1; return original.call(this) }
  assert.equal(detect().length, 100)
  assert.ok(reads <= 104, `unexpected full-document measurement: ${reads}`)
})

test('detection only reads DOM state and rejects unbounded ancestry', () => {
  const { detect, document } = page('<button id="control" style="position:fixed" data-box="20,20,60,60">A</button>')
  const before = document.body.innerHTML
  assert.deepEqual(detect(), [box(20, 20, 60, 60)])
  assert.equal(document.body.innerHTML, before)
  const control = document.getElementById('control')
  for (let i = 0; i < 65; i += 1) {
    const wrapper = document.createElement('div')
    control.parentNode.insertBefore(wrapper, control)
    wrapper.append(control)
  }
  assert.deepEqual(detect(), [])
})

test('missing roots and detached documents without a view safely yield no obstacles', () => {
  assert.deepEqual(floatingObstacles(null), [])
  assert.deepEqual(floatingObstacles({ querySelectorAll() { return [] } }), [])
})

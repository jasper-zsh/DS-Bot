import { STORAGE } from './storage.js'
import { clampPoint, floatingObstacles, placeFloating } from './floating-layout.js'

const MARGIN = 16
const DRAG_THRESHOLD = 6
const WATCH_DELAY = 250
const INTERACTIVE = 'button,[role="button"],[role="switch"],a[href],input[type="button"],input[type="submit"]'

export function readFloatingPosition(storage) {
  try {
    const value = JSON.parse((storage ?? globalThis.localStorage).getItem(STORAGE.surfacePosition) ?? 'null')
    return value?.version === 1 && [value.x, value.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)
      ? { x: value.x, y: value.y } : null
  } catch { return null }
}

export function floatingBounds(win, node) {
  const view = win.visualViewport
  const style = win.getComputedStyle(node)
  const safe = edge => Math.max(0, parseFloat(style.getPropertyValue(`--bt-float-safe-${edge}`)) || 0)
  const left = view?.offsetLeft ?? 0
  const top = view?.offsetTop ?? 0
  return {
    left: left + MARGIN + safe('left'), top: top + MARGIN + safe('top'),
    right: left + (view?.width ?? win.innerWidth) - MARGIN - safe('right'),
    bottom: top + (view?.height ?? win.innerHeight) - MARGIN - safe('bottom'),
  }
}

const fromAnchor = (anchor, size, bounds) => anchor ? {
  x: bounds.left + anchor.x * Math.max(0, bounds.right - bounds.left - size.width),
  y: bounds.top + anchor.y * Math.max(0, bounds.bottom - bounds.top - size.height),
} : { x: bounds.right - size.width, y: bounds.bottom - size.height - 64 }
const toAnchor = (point, size, bounds) => ({
  x: Math.max(0, Math.min(1, (point.x - bounds.left) / Math.max(1, bounds.right - bounds.left - size.width))),
  y: Math.max(0, Math.min(1, (point.y - bounds.top) / Math.max(1, bounds.bottom - bounds.top - size.height))),
})

// Own only this element. The scan is throttled and also runs slowly while idle,
// since another plugin can move with a CSS animation without mutating its DOM.
export function installFloatingToggle(node, { window: win = window, storage, obstacles = () => floatingObstacles(node.ownerDocument, node) } = {}) {
  const doc = node.ownerDocument
  const styleKeys = ['left', 'top', 'right', 'bottom', 'translate']
  const before = styleKeys.map(key => node.style.getPropertyValue(key))
  const localStorage = () => storage ?? win.localStorage
  let anchor
  try { anchor = readFloatingPosition(localStorage()) } catch { anchor = null }
  let point = null
  let lastBounds = ''
  let drag = null
  let suppressUntil = 0
  let timer = 0
  let frame = 0
  let disposed = false
  const sizeOf = () => ({ width: node.offsetWidth, height: node.offsetHeight })
  const apply = (next) => {
    if (point?.x === next.x && point?.y === next.y) return
    point = next
    node.style.left = '0px'
    node.style.top = '0px'
    node.style.right = 'auto'
    node.style.bottom = 'auto'
    node.style.translate = `${next.x}px ${next.y}px`
  }
  const save = () => {
    anchor = toAnchor(point, sizeOf(), floatingBounds(win, node))
    try { localStorage().setItem(STORAGE.surfacePosition, JSON.stringify({ version: 1, ...anchor })) } catch { /* storage unavailable */ }
  }
  const measure = () => {
    if (disposed || drag || doc.hidden) return
    const size = sizeOf()
    if (size.width <= 0 || size.height <= 0) return
    const bounds = floatingBounds(win, node)
    const signature = JSON.stringify(bounds)
    // A collision-free current place is sticky: two independently avoiding
    // plugins must not keep fighting to reclaim their original corner.
    const wanted = point === null || lastBounds !== signature ? fromAnchor(anchor, size, bounds) : point
    lastBounds = signature
    apply(placeFloating(wanted, size, bounds, obstacles()))
  }
  const schedule = () => {
    if (disposed || timer || frame) return
    timer = win.setTimeout(() => {
      timer = 0
      frame = win.requestAnimationFrame(() => { frame = 0; measure() })
    }, WATCH_DELAY)
  }
  const release = (id) => {
    try { if (node.hasPointerCapture?.(id)) node.releasePointerCapture(id) } catch { /* pointer already cancelled */ }
  }
  const finish = (cancelled) => {
    const ended = drag
    if (!ended) return
    drag = null
    delete node.dataset.floatingDragging
    release(ended.id)
    if (ended.moved) {
      suppressUntil = Date.now() + 800
      if (cancelled) apply(clampPoint(ended.origin, sizeOf(), floatingBounds(win, node)))
      else {
        apply(placeFloating(point, sizeOf(), floatingBounds(win, node), obstacles()))
        save()
      }
    }
    schedule()
  }
  const down = (event) => {
    if (drag || event.button !== 0 || event.isPrimary === false) return
    suppressUntil = 0
    const box = node.getBoundingClientRect()
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: { x: box.left, y: box.top }, moved: false }
    try { node.setPointerCapture(event.pointerId) } catch { /* window listeners still finish the gesture */ }
  }
  const move = (event) => {
    if (!drag || event.pointerId !== drag.id) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    node.dataset.floatingDragging = ''
    event.preventDefault()
    apply(clampPoint({ x: drag.origin.x + dx, y: drag.origin.y + dy }, sizeOf(), floatingBounds(win, node)))
  }
  const up = event => { if (drag?.id === event.pointerId) finish(false) }
  const cancel = event => { if (drag?.id === event.pointerId) finish(true) }
  const click = (event) => {
    // Keyboard/assistive activation has detail=0 and must never be swallowed.
    if (event.detail === 0 || Date.now() > suppressUntil) return
    suppressUntil = 0
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const key = (event) => {
    if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || drag) return
    const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key]
    if (!delta || !point) return
    event.preventDefault()
    event.stopPropagation()
    apply(placeFloating({ x: point.x + delta[0], y: point.y + delta[1] }, sizeOf(), floatingBounds(win, node), obstacles()))
    save()
  }
  const blur = () => finish(true)
  const visibility = () => { if (doc.hidden) finish(true); else schedule() }
  node.addEventListener('pointerdown', down)
  win.addEventListener('pointermove', move, { passive: false })
  win.addEventListener('pointerup', up)
  win.addEventListener('pointercancel', cancel)
  node.addEventListener('lostpointercapture', cancel)
  node.addEventListener('click', click, true)
  node.addEventListener('keydown', key)
  win.addEventListener('blur', blur)
  win.addEventListener('resize', schedule)
  doc.addEventListener('scroll', schedule, { capture: true, passive: true })
  doc.addEventListener('visibilitychange', visibility)
  win.visualViewport?.addEventListener('resize', schedule)
  win.visualViewport?.addEventListener('scroll', schedule)
  const resize = win.ResizeObserver ? new win.ResizeObserver(schedule) : null
  resize?.observe(node)
  const mutations = win.MutationObserver ? new win.MutationObserver((records) => {
    const interactive = element => element.nodeType === 1 && (element.matches(INTERACTIVE) || element.querySelector(INTERACTIVE) || element.shadowRoot)
    if (records.some(record => !node.contains(record.target) && (record.type === 'attributes'
      ? interactive(record.target)
      : [...record.addedNodes, ...record.removedNodes].some(interactive)))) schedule()
  }) : null
  mutations?.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open', 'popover'] })
  const interval = win.setInterval(() => { if (!doc.hidden) schedule() }, 1000)
  measure()
  return () => {
    disposed = true
    if (drag) { const id = drag.id; drag = null; release(id) }
    delete node.dataset.floatingDragging
    win.clearTimeout(timer)
    win.clearInterval(interval)
    if (frame) win.cancelAnimationFrame(frame)
    resize?.disconnect()
    mutations?.disconnect()
    node.removeEventListener('pointerdown', down)
    win.removeEventListener('pointermove', move)
    win.removeEventListener('pointerup', up)
    win.removeEventListener('pointercancel', cancel)
    node.removeEventListener('lostpointercapture', cancel)
    node.removeEventListener('click', click, true)
    node.removeEventListener('keydown', key)
    win.removeEventListener('blur', blur)
    win.removeEventListener('resize', schedule)
    doc.removeEventListener('scroll', schedule, true)
    doc.removeEventListener('visibilitychange', visibility)
    win.visualViewport?.removeEventListener('resize', schedule)
    win.visualViewport?.removeEventListener('scroll', schedule)
    styleKeys.forEach((name, i) => { if (before[i]) node.style.setProperty(name, before[i]); else node.style.removeProperty(name) })
  }
}

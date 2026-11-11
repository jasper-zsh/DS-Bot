const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback)
const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high))
const dimensions = size => ({ width: Math.max(0, finite(size?.width)), height: Math.max(0, finite(size?.height)) })

export function clampPoint(point, size, bounds) {
  const { width, height } = dimensions(size)
  const left = finite(bounds?.left)
  const top = finite(bounds?.top)
  return {
    x: clamp(finite(point?.x, left), left, finite(bounds?.right, left) - width),
    y: clamp(finite(point?.y, top), top, finite(bounds?.bottom, top) - height),
  }
}

const rectangle = value => value && ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(value[key]))
  && value.right > value.left && value.bottom > value.top
const overlap = (point, size, obstacle, gap) => Math.max(0, Math.min(point.x + size.width, obstacle.right + gap) - Math.max(point.x, obstacle.left - gap))
  * Math.max(0, Math.min(point.y + size.height, obstacle.bottom + gap) - Math.max(point.y, obstacle.top - gap))
const distance = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2

// Every boundary of the forbidden top-left regions participates. Considering both
// axes together finds corridors in a union of obstacles, without relocation loops.
export function placeFloating(point, size, bounds, obstacles = [], gap = 8) {
  size = dimensions(size)
  gap = Math.max(0, finite(gap))
  const preferred = clampPoint(point, size, bounds)
  if (size.width === 0 || size.height === 0) return preferred
  const blocked = [...new Map(obstacles.filter(rectangle).map(rect => [
    `${rect.left},${rect.top},${rect.right},${rect.bottom}`, rect,
  ])).values()].sort((a, b) => a.left - b.left || a.top - b.top || a.right - b.right || a.bottom - b.bottom)
  const score = (candidate, ceiling = Infinity) => {
    let total = 0
    for (const obstacle of blocked) {
      total += overlap(candidate, size, obstacle, gap)
      if (total > ceiling) break
    }
    return total
  }
  const target = { x: finite(point?.x, preferred.x), y: finite(point?.y, preferred.y) }
  let best = preferred
  let bestOverlap = score(best)
  if (bestOverlap === 0) return best
  let bestDistance = distance(best, target)
  const low = clampPoint({ x: -Number.MAX_VALUE, y: -Number.MAX_VALUE }, size, bounds)
  const high = clampPoint({ x: Number.MAX_VALUE, y: Number.MAX_VALUE }, size, bounds)
  const xs = [preferred.x, low.x, high.x]
  const ys = [preferred.y, low.y, high.y]
  for (const rect of blocked) {
    xs.push(rect.left - size.width - gap, rect.right + gap)
    ys.push(rect.top - size.height - gap, rect.bottom + gap)
  }
  const unique = (values, low, high) => [...new Set(values.map(value => clamp(value, low, high)))].sort((a, b) => a - b)
  for (const x of unique(xs, low.x, high.x)) {
    for (const y of unique(ys, low.y, high.y)) {
      const candidate = { x, y }
      const area = score(candidate, bestOverlap)
      const away = distance(candidate, target)
      if (area < bestOverlap || (area === bestOverlap && (away < bestDistance
        || (away === bestDistance && (y < best.y || (y === best.y && x < best.x)))))) {
        best = candidate
        bestOverlap = area
        bestDistance = away
      }
    }
  }
  return best
}

const CONTROLS = 'button,[role="button"],[role="switch"],a[href],input[type="button"],input[type="submit"],input[type="reset"],input[type="image"]'
const CANDIDATES = `${CONTROLS},[tabindex],[style*="position"],[class*="floating"],[class*="float"],[class*="Floating"],[class*="Float"],[class*="fab"],[class*="launcher"],[class*="Launcher"]`
const EXCLUDED = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="menubar"],[popover]'
const MAX_CONTROLS = 500
const MAX_OBSTACLES = 100
const MAX_ROOTS = 100
const parentOf = element => element.parentElement ?? element.getRootNode?.().host ?? null
const compact = (rect, width = 320, height = 160) => rect.right - rect.left <= width && rect.bottom - rect.top <= height
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const covers = (rect, viewport) => rect.left <= viewport.left + 1 && rect.top <= viewport.top + 1
  && rect.right >= viewport.right - 1 && rect.bottom >= viewport.bottom - 1

// Scope repeated measurements to known overlay roots when possible. This never
// walks '*' to discover shadow hosts: direct hosts and explicitly supplied roots
// are supported, while arbitrary deep and closed shadow trees stay opaque.
export function floatingObstacles(root, owner) {
  root ??= globalThis.document
  const document = root?.nodeType === 9 ? root : root?.ownerDocument
  const view = document?.defaultView
  if (!view || !root?.querySelectorAll) return []
  const visual = view.visualViewport
  const left = finite(visual?.offsetLeft)
  const top = finite(visual?.offsetTop)
  const viewport = {
    left, top,
    right: left + finite(visual?.width, view.innerWidth),
    bottom: top + finite(visual?.height, view.innerHeight),
  }
  const styles = new WeakMap()
  const rects = new WeakMap()
  const styleOf = element => {
    if (!styles.has(element)) styles.set(element, view.getComputedStyle(element))
    return styles.get(element)
  }
  const rectOf = element => {
    if (!rects.has(element)) {
      const rect = element.getBoundingClientRect()
      rects.set(element, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
    }
    return rects.get(element)
  }
  const qualifies = (control) => {
    const style = styleOf(control)
    if (control.disabled || control.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none') return false
    if (!control.matches(CONTROLS) && (style.cursor !== 'pointer' || control.matches('[role="toolbar"]'))) return false
    const rect = rectOf(control)
    if (!rectangle(rect) || !compact(rect, 240, 120) || !intersects(rect, viewport)) return false
    let fixed = null
    let absolute = false
    let large = false
    let depth = 0
    for (let node = control; node; node = parentOf(node)) {
      if (depth++ >= 64) return false
      if (node === owner || node.matches(EXCLUDED) || node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return false
      const style = styleOf(node)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || (style.opacity !== '' && Number(style.opacity) === 0) || style.contentVisibility === 'hidden') return false
      if (fixed) continue
      if (style.position === 'fixed') {
        const box = rectOf(node)
        fixed = node === control || (!large && (compact(box) || (absolute && style.pointerEvents === 'none' && covers(box, viewport))))
        // A fixed ancestor that is not a floating surface must not fall through
        // to another fixed viewport container farther up the page.
        if (!fixed) fixed = 'rejected'
      } else {
        if (style.position === 'absolute' && compact(rectOf(node))) absolute = true
        if (node !== control && !compact(rectOf(node)) && style.pointerEvents !== 'none') large = true
      }
    }
    return fixed === true
  }
  const roots = [root]
  const queued = new Set(roots)
  const seen = new Set()
  const occupied = new Set()
  const result = []
  let inspected = 0
  const addShadow = (element) => {
    const shadow = element?.shadowRoot
    if (shadow && !queued.has(shadow) && roots.length < MAX_ROOTS) { queued.add(shadow); roots.push(shadow) }
  }
  for (let index = 0; index < roots.length && inspected < MAX_CONTROLS && result.length < MAX_OBSTACLES; index += 1) {
    const scope = roots[index]
    addShadow(scope)
    for (const child of [...(scope.children ?? [])].slice(-MAX_ROOTS)) addShadow(child)
    if (scope.nodeType === 9) for (const child of [...(scope.body?.children ?? [])].slice(-MAX_ROOTS)) addShadow(child)
    const controls = [...scope.querySelectorAll(CANDIDATES)]
    if (scope.matches?.(CANDIDATES)) controls.push(scope)
    // Portalled floating controls usually follow the long conversation body.
    for (let i = controls.length - 1; i >= 0 && inspected < MAX_CONTROLS && result.length < MAX_OBSTACLES; i -= 1) {
      const control = controls[i]
      if (seen.has(control)) continue
      seen.add(control)
      inspected += 1
      addShadow(control)
      if (qualifies(control)) {
        const rect = rectOf(control)
        const key = `${rect.left},${rect.top},${rect.right},${rect.bottom}`
        if (!occupied.has(key)) { occupied.add(key); result.push(rect) }
      }
    }
  }
  return result
}

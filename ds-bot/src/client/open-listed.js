// DSH's main view opens only a Session that its client list already holds; any other id
// throws `sessions.retain: unknown session`. A part the Host made a moment ago, or any part
// before the first list arrives, waits for the list; a newer navigation — through here or
// elsewhere — drops the wait.
export function listedOpener({ list, open, refresh, current }) {
  let drop = () => {}
  const cancel = () => { const stop = drop; drop = () => {}; stop() }
  const show = (target, { valid = () => true, timeout = 0 } = {}) => {
    cancel()
    if (!valid()) return
    const listed = () => Object.hasOwn(list.getSnapshot().byId ?? {}, target)
    if (listed()) { open(target); return }
    const from = current?.()
    let active = true
    let timer = 0
    let off = () => {}
    const stop = () => {
      active = false
      off()
      clearTimeout(timer)
      if (drop === stop) drop = () => {}
    }
    off = list.subscribe(() => {
      // A source can already be dispatching a copied listener list when cancelled.
      if (!active) return
      if (!valid() || current?.() !== from) { stop(); return }
      if (!listed()) return
      stop()
      if (valid()) open(target)
    })
    drop = stop
    if (timeout > 0) timer = setTimeout(stop, timeout)
    refresh?.()
  }
  show.cancel = cancel
  return show
}

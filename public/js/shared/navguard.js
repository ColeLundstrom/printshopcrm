/* -------------------------------------------------------------------------------------------------
 * The router's unsaved-work guard.
 *
 * A hash change is this app's ONLY navigation, and until now nothing could refuse one. Two screens
 * are ones where a shop types for ten minutes before saving once: the price-matrix grid, which
 * grew its own guard, and the estimate editor, which had none — so Cancel, a sidebar click, the
 * `g e` shortcut, the browser's Back button and a tab close all threw a whole quote away in
 * silence.
 *
 * Refusing a hash change means putting the URL back, and putting the URL back fires `hashchange`
 * again — which would re-run the router and repaint the editor, destroying exactly the work being
 * protected. That echo is the whole reason this is a state machine and not an `if`.
 *
 * Kept DOM-free and in shared/ so the gate can exercise every path headlessly.
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {(hash: string) => void} setHash  how to put the URL back (`location.hash = h` in the app)
 */
export function createNavGuard(setHash) {
  let currentHash = null   // null until the first accepted navigation, so boot is never guarded
  let reverting = false    // true while our own revert's hashchange is still in flight
  let guard = null         // the current view's "may I leave?" predicate, if it registered one

  return {
    /** A view holding unsaved work registers here. Cleared automatically on the next navigation. */
    register(fn) { guard = fn },

    /** Test seam / introspection: is a guard armed right now? */
    armed() { return typeof guard === 'function' },

    /**
     * Called for every hashchange. Returns true when the router should run for `target`.
     *
     * A guard returns false to REFUSE the navigation; it then owns asking the person and
     * re-issuing the navigation itself once they have answered. A guard that throws is ignored
     * rather than allowed to wedge the app on one screen — a broken guard must never be a trap.
     */
    accept(target) {
      if (reverting) { reverting = false; return false }
      if (guard && currentHash !== null && target !== currentHash) {
        let ok = true
        try { ok = guard(target) !== false } catch { ok = true }
        if (!ok) { reverting = true; setHash(currentHash); return false }
      }
      currentHash = target
      guard = null
      return true
    },
  }
}

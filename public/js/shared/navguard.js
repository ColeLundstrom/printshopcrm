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
      // Note there is NO `target !== currentHash` test here. There used to be, from when a
      // same-hash click meant "nothing happens" — but clicking the sidebar item for the screen you
      // are already on now REPAINTS that screen from the server, deliberately, so that a stale or
      // failed view always has a way to refresh itself. A repaint destroys exactly the same
      // unsaved work a navigation does. Skipping the guard there meant clicking "Settings" while
      // standing on Settings threw away the shop's edits without asking — and worse, fell through
      // to `guard = null` below, so the guard was disarmed for the freshly-painted screen too.
      if (guard && currentHash !== null) {
        const samePage = target === currentHash
        let ok = true
        try { ok = guard(target) !== false } catch { ok = true }
        if (!ok) {
          // A same-page repaint has no URL to put back: setHash(currentHash) would assign the hash
          // the value it already holds, which fires no hashchange, so `reverting` would never be
          // cleared and the next REAL navigation would be swallowed in its place. Refusing is
          // enough — the screen simply does not repaint.
          if (!samePage) { reverting = true; setHash(currentHash) }
          return false
        }
      }
      currentHash = target
      guard = null
      return true
    },
  }
}

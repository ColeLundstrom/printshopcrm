/** A browser-local layout preference, independent of shop data and mobile drawer state. */
export function mountDesktopNavigation({ root, sidebar, button, media, read, write, closeMobileDrawer }) {
  if (!button || !sidebar) return
  let collapsed = false
  try { collapsed = read() === 'collapsed' } catch { /* Storage can be disabled. */ }
  const render = () => {
    const hidingFocusedNav = media.matches && collapsed && sidebar.contains(root.ownerDocument.activeElement)
    root.dataset.navigation = collapsed ? 'collapsed' : 'expanded'
    button.setAttribute('aria-expanded', String(!collapsed))
    button.textContent = collapsed ? 'Show navigation' : 'Hide navigation'
    if (hidingFocusedNav) button.focus()
  }
  button.addEventListener('click', () => {
    if (!media.matches) return
    collapsed = !collapsed
    try { write(collapsed ? 'collapsed' : 'expanded') } catch { /* Keep working in memory. */ }
    render()
  })
  media.addEventListener('change', () => {
    if (media.matches) closeMobileDrawer()
    render()
  })
  render()
}

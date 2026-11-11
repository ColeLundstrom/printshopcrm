/** Flat filename used by snapshot.mjs on POSIX and Windows. */
export function snapshotName(relativePath) {
  return relativePath.replace(/[\\/]/g, '__')
}

/** Return the first pair that would overwrite the same snapshot file. */
export function snapshotCollision(relativePaths) {
  const byName = new Map()
  for (const path of relativePaths) {
    const name = snapshotName(path)
    if (byName.has(name)) return { name, first: byName.get(name), second: path }
    byName.set(name, path)
  }
  return null
}

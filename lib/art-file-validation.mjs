import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'

export const ART_ASSET_LIMIT = 40 * 1024 * 1024
export const ART_ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.pdf', '.eps', '.ai', '.psd', '.tif', '.tiff', '.dst', '.pes', '.jef', '.exp']
const bad = message => Object.assign(new Error(message), { status: 400, expose: true })

/** Store original bytes for human prepress review. Never decode, render or execute these files. */
export async function inspectArtAsset(file) {
  const extension = extname(file.originalname || '').toLowerCase()
  if (!ART_ASSET_EXTENSIONS.includes(extension)) throw bad('Use PNG, JPG, WebP, SVG, PDF, EPS, AI, PSD, TIFF, DST, PES, JEF or EXP.')
  const handle = await open(file.path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > ART_ASSET_LIMIT) throw bad('Choose a nonempty file up to 40 MiB.')
    const header = Buffer.alloc(Math.min(2048, stat.size))
    await handle.read(header, 0, header.length, 0)
    const text = header.toString('utf8')
    const pdf = header.subarray(0, 5).toString('ascii') === '%PDF-'
    const postscript = text.startsWith('%!PS') || header.subarray(0, 4).equals(Buffer.from([0xc5, 0xd0, 0xd3, 0xc6]))
    const tiff = header.length >= 4 && (
      (header[0] === 0x49 && header[1] === 0x49 && [42, 43].includes(header[2]) && header[3] === 0) ||
      (header[0] === 0x4d && header[1] === 0x4d && header[2] === 0 && [42, 43].includes(header[3])))
    const valid = {
      '.png': header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      '.jpg': header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff,
      '.jpeg': header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff,
      '.webp': header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP',
      '.svg': /<svg[\s>]/i.test(text),
      '.pdf': pdf,
      '.eps': postscript,
      '.ai': pdf || postscript,
      '.psd': header.subarray(0, 4).toString('ascii') === '8BPS',
      '.tif': tiff,
      '.tiff': tiff,
      '.dst': stat.size >= 512 && text.startsWith('LA:'),
      '.pes': text.startsWith('#PES'),
      // These handoff formats have no reliable common magic signature. Store them as opaque
      // attachments; a staff release, not this check, records the machine/software review.
      '.jef': stat.size >= 20,
      '.exp': stat.size >= 2 && stat.size % 2 === 0,
    }[extension]
    if (!valid) throw bad('The file header does not match its extension. Export it again from your artwork software.')
    const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024)
    let position = 0
    while (position < stat.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position)
      if (!bytesRead) throw bad('The upload changed while it was being read. Upload it again.')
      hash.update(chunk.subarray(0, bytesRead)); position += bytesRead
    }
    if ((await handle.stat()).size !== stat.size) throw bad('The upload changed while it was being read. Upload it again.')
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.tif': 'image/tiff', '.tiff': 'image/tiff' })[extension] || 'application/octet-stream'
    return { size: stat.size, sha256: hash.digest('hex'), mime }
  } finally { await handle.close() }
}

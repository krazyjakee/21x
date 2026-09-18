import { extname } from 'path'

// Where several extensions share a MIME type, the first one listed is the one
// extensionForMimeType() returns.
const MIME_TYPES: Record<string, string> = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  // Text and code
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.ini': 'text/plain',
  '.toml': 'text/plain',
  '.py': 'text/plain',
  '.sh': 'text/plain',
  '.sql': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  // Audio and video
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

const EXTENSIONS: Record<string, string> = {}
for (const [ext, mime] of Object.entries(MIME_TYPES)) {
  EXTENSIONS[mime] ??= ext
}

const DEFAULT_MIME_TYPE = 'application/octet-stream'

/** MIME type for a file path or name, by extension. */
export function mimeTypeForPath(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? DEFAULT_MIME_TYPE
}

/** Whether mimeTypeForPath() knows the extension of this path. */
export function hasKnownExtension(path: string): boolean {
  return extname(path).toLowerCase() in MIME_TYPES
}

/** Preferred extension (with leading dot) for a MIME type, or '' if unknown. */
export function extensionForMimeType(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? ''
}

/** MIME type detected from the leading magic bytes, or null if unrecognised. */
export function sniffMimeType(buffer: Uint8Array): string | null {
  if (buffer.length < 4) return null
  const [a, b, c, d] = buffer
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return 'image/png'
  if (a === 0xff && b === 0xd8 && c === 0xff) return 'image/jpeg'
  if (a === 0x47 && b === 0x49 && c === 0x46 && d === 0x38) return 'image/gif'
  if (a === 0x25 && b === 0x50 && c === 0x44 && d === 0x46) return 'application/pdf'
  // Also matches docx/xlsx/pptx, which are ZIP containers.
  if (a === 0x50 && b === 0x4b && (c === 0x03 || c === 0x05 || c === 0x07)) return 'application/zip'
  return null
}

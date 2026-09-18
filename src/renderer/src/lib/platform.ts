export const isWindows = navigator.platform.toLowerCase().startsWith('win') || navigator.userAgent.includes('Windows')
const isMac = navigator.platform.toLowerCase().includes('mac')

export const platform: 'win32' | 'darwin' | 'linux' = isWindows ? 'win32' : isMac ? 'darwin' : 'linux'
export const modKey = isMac ? '⌘' : 'Ctrl'

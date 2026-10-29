/** The WebView's host OS; unknown agents retain Windows compatibility. */
export function hostPlatform(userAgent = navigator.userAgent): 'windows' | 'macos' | 'linux' {
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
  if (/Linux/i.test(userAgent)) return 'linux';
  return 'windows';
}

export function localSeparator(): '/' | '\\' {
  return hostPlatform() === 'windows' ? '\\' : '/';
}

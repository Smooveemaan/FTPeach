# Unix updates require a current server offer

On macOS and Linux, a saved update is installed only after a fresh successful
check still offers the same version and signature. If the server is unavailable,
FTPeach continues running and keeps the download for another launch or an explicit
installation attempt. This lets us use the updater plugin's native installer
without maintaining a patched plugin for offline installation; Windows keeps its
existing offline installation path. The fresh offer does not replace signature
verification or the version check inside the signed package.

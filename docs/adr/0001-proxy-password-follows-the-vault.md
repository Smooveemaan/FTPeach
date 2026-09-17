# The proxy password follows the vault

Under enhanced protection the proxy password is stored in the vault like any other saved secret, although it once stayed in DPAPI. A user who turns on enhanced protection expects no saved secret to be readable without the master password. The cost is that a connection through a password-protected proxy, even to an unsaved server, asks to unlock the vault first.

"""pyftpdlib matrix server: plain FTP and explicit FTPS on one port, MLSD.

PYFTPDLIB_VARIANT selects the target:
  standard    UTF-8, PASV and EPSV
  epsv_only   PASV answers 502, the client has to use EPSV
  nonutf8     cp1251 file names, no UTF8 in FEAT, OPTS UTF8 refused
"""

import locale
import os
import sys

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import TLS_FTPHandler
from pyftpdlib.servers import FTPServer

VARIANT = os.environ.get("PYFTPDLIB_VARIANT", "standard")
PASSIVE_START = int(os.environ["PYFTPDLIB_PASSIVE_START"])
PASSIVE_END = int(os.environ["PYFTPDLIB_PASSIVE_END"])


class EpsvOnlyHandler(TLS_FTPHandler):
    def ftp_PASV(self, line):
        self.respond("502 PASV disabled on this server, use EPSV.")


class NonUtf8Handler(TLS_FTPHandler):
    encoding = "cp1251"

    def ftp_OPTS(self, line):
        if line.strip().upper().startswith("UTF8"):
            self.respond("501 UTF8 not supported.")
            return
        super().ftp_OPTS(line)


def main():
    handlers = {
        "standard": TLS_FTPHandler,
        "epsv_only": EpsvOnlyHandler,
        "nonutf8": NonUtf8Handler,
    }
    handler = handlers[VARIANT]
    if VARIANT == "nonutf8":
        locale.setlocale(locale.LC_ALL, "")
        if sys.getfilesystemencoding().lower() not in ("cp1251", "windows-1251"):
            raise SystemExit(
                f"nonutf8 needs a cp1251 file-system encoding, got {sys.getfilesystemencoding()}"
            )

    authorizer = DummyAuthorizer()
    authorizer.add_user("testuser", "testpass", "/home/testuser", perm="elradfmwMT")
    handler.authorizer = authorizer
    handler.certfile = "/tls/localhost.pem"
    handler.keyfile = "/tls/localhost.key"
    handler.tls_control_required = False
    handler.tls_data_required = False
    handler.masquerade_address = "127.0.0.1"
    handler.passive_ports = range(PASSIVE_START, PASSIVE_END + 1)
    handler.banner = f"FTPeach matrix pyftpdlib ({VARIANT}) ready."

    server = FTPServer(("0.0.0.0", 2121), handler)
    server.max_cons = 64
    server.serve_forever()


if __name__ == "__main__":
    main()

# FTP cannot promise not to replace a file

FTP has no rename that fails when the target exists. An upload that must not replace a file checks that the name is free and then renames its staging file with a plain `RNFR`/`RNTO`, and a refused rename is reported, never retried as a replacement. A file another client creates between the check and the rename can still be replaced by servers that let `RNTO` overwrite; that gap is the protocol's, and SFTP and WebDAV, which can refuse an existing target, do not have it.

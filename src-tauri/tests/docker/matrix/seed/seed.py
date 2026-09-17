#!/usr/bin/env python3
"""Writes the server-side fixtures into matrix server volumes.

Usage: seed.py TARGET [TARGET...]
TARGET is PATH:UID:GID[:FLAG+FLAG...]. Flags:
  nolinks  skip symlinks (servers that refuse or rescan them, e.g. Nextcloud)
  noperms  skip the unreadable file/dir (servers that index as root)
  cp1251   add names encoded in cp1251 (the non-UTF-8 pyftpdlib variant)

Everything lands under PATH/fixtures. Tests write to their own per-run
directories next to it, so fixtures are only read. A marker file records the
seed version and big-file size; a matching marker skips the target, a
different one rebuilds its fixtures from scratch.

Non-ASCII names are written as escapes: the repository's no-Cyrillic gate scans
this file.
"""

import os
import random
import shutil
import sys

SEED_VERSION = "1"
BIG_MB = int(os.environ.get("FTPEACH_MATRIX_BIG_MB", "64"))
MANY_FILES = 10_000
DEEP_LEVELS = 30

UNICODE_NAMES = [
    "\u041f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440.txt",  # Cyrillic
    "\u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb.txt",  # Japanese
    "\u4e2d\u6587\u6587\u4ef6.txt",  # Chinese
    "\ud55c\uad6d\uc5b4.txt",  # Korean
    "emoji \U0001f351\U0001f680.txt",
    "caf\u00e9 na\u00efve.txt",  # Latin with diacritics (NFC)
    "with spaces.txt",
    "  leading and trailing spaces  .txt",
    "-leading-dash.txt",
    "#hash %percent &ampersand +plus ;semicolon.txt",
    "brackets [x] (y) {z}.txt",
    "quote's and \"double\".txt",
    "Case.txt",
    "case.txt",
    # 255 bytes: the usual file-name limit on ext4.
    "n" * 251 + ".txt",
]
UNICODE_DIRS = [
    "\u041f\u0430\u043f\u043a\u0430",  # Cyrillic directory
    "\u30c7\u30a3\u30ec\u30af\u30c8\u30ea",  # Japanese directory
    "dir with spaces",
]
CP1251_NAMES = [
    "\u041e\u0442\u0447\u0435\u0442.txt",
    "\u0414\u0430\u043d\u043d\u044b\u0435 2026.txt",
]


def write(path, data, uid, gid, mode=0o644):
    with open(path, "wb") as handle:
        handle.write(data)
    os.chown(path, uid, gid)
    os.chmod(path, mode)


def mkdir(path, uid, gid, mode=0o755):
    os.makedirs(path, exist_ok=True)
    os.chown(path, uid, gid)
    os.chmod(path, mode)


def seed_names(root, uid, gid):
    names = os.path.join(root, "names")
    mkdir(names, uid, gid)
    for name in UNICODE_NAMES:
        write(os.path.join(names, name), name.encode("utf-8") + b"\n", uid, gid)
    for name in UNICODE_DIRS:
        directory = os.path.join(names, name)
        mkdir(directory, uid, gid)
        write(os.path.join(directory, "inner.txt"), b"inner\n", uid, gid)


def seed_cp1251(root, uid, gid):
    encoding = os.path.join(root, "encoding").encode()
    mkdir(encoding, uid, gid)
    for name in CP1251_NAMES:
        path = encoding + b"/" + name.encode("cp1251")
        write(path, name.encode("utf-8") + b"\n", uid, gid)


def seed_many(root, uid, gid):
    many = os.path.join(root, "many")
    mkdir(many, uid, gid)
    for index in range(MANY_FILES):
        write(os.path.join(many, f"file-{index:05d}.txt"), f"{index}\n".encode(), uid, gid)


def seed_deep(root, uid, gid):
    path = os.path.join(root, "deep")
    mkdir(path, uid, gid)
    for level in range(1, DEEP_LEVELS + 1):
        path = os.path.join(path, f"d{level:02d}")
        mkdir(path, uid, gid)
        write(os.path.join(path, "level.txt"), f"{level}\n".encode(), uid, gid)


def seed_sizes(root, uid, gid):
    sizes = os.path.join(root, "sizes")
    mkdir(sizes, uid, gid)
    write(os.path.join(sizes, "empty.bin"), b"", uid, gid)
    write(os.path.join(sizes, "small.txt"), b"FTPeach matrix fixture\n", uid, gid)
    # Deterministic pseudo-random content: every MiB differs, so a resume that
    # restarts at the wrong offset changes the hash.
    generator = random.Random(20260913)
    big = os.path.join(sizes, "big.bin")
    with open(big, "wb") as handle:
        for _ in range(BIG_MB):
            handle.write(generator.randbytes(1 << 20))
    os.chown(big, uid, gid)
    os.chmod(big, 0o644)


def seed_links(root, uid, gid):
    links = os.path.join(root, "links")
    mkdir(links, uid, gid)
    write(os.path.join(links, "target.txt"), b"link target\n", uid, gid)
    mkdir(os.path.join(links, "target-dir"), uid, gid)
    write(os.path.join(links, "target-dir", "inner.txt"), b"inner\n", uid, gid)
    for link, target in [
        ("link-to-file", "target.txt"),
        ("link-to-dir", "target-dir"),
        ("broken-link", "missing-target"),
    ]:
        path = os.path.join(links, link)
        os.symlink(target, path)
        os.lchown(path, uid, gid)


def seed_perms(root, uid, gid):
    perms = os.path.join(root, "perms")
    mkdir(perms, uid, gid)
    write(os.path.join(perms, "readable.txt"), b"readable\n", uid, gid)
    write(os.path.join(perms, "no-read.txt"), b"secret\n", uid, gid, mode=0o000)
    locked = os.path.join(perms, "no-read-dir")
    mkdir(locked, uid, gid)
    write(os.path.join(locked, "inner.txt"), b"inner\n", uid, gid)
    os.chmod(locked, 0o000)
    read_only = os.path.join(perms, "read-only-dir")
    mkdir(read_only, uid, gid)
    write(os.path.join(read_only, "inner.txt"), b"inner\n", uid, gid)
    os.chmod(read_only, 0o555)


def seed_hidden(root, uid, gid):
    hidden = os.path.join(root, "hidden")
    mkdir(hidden, uid, gid)
    write(os.path.join(hidden, "visible.txt"), b"visible\n", uid, gid)
    write(os.path.join(hidden, ".dotfile"), b"hidden\n", uid, gid)
    mkdir(os.path.join(hidden, ".dotdir"), uid, gid)
    write(os.path.join(hidden, ".dotdir", "inner.txt"), b"inner\n", uid, gid)


def seed_target(spec):
    parts = spec.split(":")
    if len(parts) not in (3, 4):
        raise SystemExit(f"bad target {spec!r}: expected PATH:UID:GID[:FLAGS]")
    base, uid, gid = parts[0], int(parts[1]), int(parts[2])
    flags = set(parts[3].split("+")) if len(parts) == 4 and parts[3] else set()

    mkdir(base, uid, gid)
    marker = os.path.join(base, ".ftpeach-seed")
    expected = f"version={SEED_VERSION} big_mb={BIG_MB} flags={'+'.join(sorted(flags))}\n"
    try:
        with open(marker, encoding="utf-8") as handle:
            if handle.read() == expected:
                print(f"{base}: fixtures are current")
                return
    except FileNotFoundError:
        pass

    root = os.path.join(base, "fixtures")
    shutil.rmtree(root, ignore_errors=True)
    mkdir(root, uid, gid)
    seed_names(root, uid, gid)
    seed_many(root, uid, gid)
    seed_deep(root, uid, gid)
    seed_sizes(root, uid, gid)
    seed_hidden(root, uid, gid)
    if "nolinks" not in flags:
        seed_links(root, uid, gid)
    if "noperms" not in flags:
        seed_perms(root, uid, gid)
    if "cp1251" in flags:
        seed_cp1251(root, uid, gid)

    write(marker, expected.encode(), uid, gid)
    print(f"{base}: fixtures written ({BIG_MB} MiB big file, flags: {sorted(flags) or 'none'})")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for spec in sys.argv[1:]:
        seed_target(spec)


if __name__ == "__main__":
    main()

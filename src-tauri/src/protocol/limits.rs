pub const MAX_DIRECTORY_ENTRIES: usize = 10_000;
/// What a server may send for a full directory before it is filtered: the
/// folder itself and its parent (`.`, `..`, MLSD cdir/pdir, the PROPFIND
/// collection) and a LIST `total` line do not count toward the limit.
pub const MAX_RAW_DIRECTORY_ENTRIES: usize = MAX_DIRECTORY_ENTRIES + 3;
pub const MAX_DIRECTORY_TEXT_BYTES: usize = 8 * 1024 * 1024;

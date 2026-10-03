/// As many as a folder on this computer may hold in a pane or a folder
/// transfer. Servers hold folders of more than 10 000 files, and below it
/// such a folder could be neither opened, filled nor deleted.
pub const MAX_DIRECTORY_ENTRIES: usize = 100_000;
/// What a server may send for a full directory before it is filtered: the
/// folder itself and its parent (`.`, `..`, MLSD cdir/pdir, the PROPFIND
/// collection) and a LIST `total` line do not count toward the limit.
pub const MAX_RAW_DIRECTORY_ENTRIES: usize = MAX_DIRECTORY_ENTRIES + 3;
pub const MAX_DIRECTORY_TEXT_BYTES: usize = 32 * 1024 * 1024;

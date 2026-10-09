# Run by makensis on the finished installer (`!finalize` in hooks.nsh).
#
# FTPeach checks the version an installer carries before running it as an
# update (embedded_version in src-tauri/src/runtime/update_staging.rs). NSIS
# writes the installer's VS_FIXEDFILEINFO with a structure version of 0, and
# FTPeach 0.3.0 to 0.4.0 look only for one of 1.0, so they refuse every
# installer as carrying no version. This appends a copy of that structure
# with 1.0 after the installer's data, where NSIS does not read and those
# versions find it. The updater signature is made afterwards, over these
# bytes.
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$bytes = [System.IO.File]::ReadAllBytes($Path)
# One character per byte, so a byte pattern is found by string search.
$text = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
$signature = "$([char]0xBD)$([char]0x04)$([char]0xEF)$([char]0xFE)"
$structure0 = "$signature$([char]0)$([char]0)$([char]0)$([char]0)"
$structure1 = "$signature$([char]0)$([char]0)$([char]1)$([char]0)"

if ($text.IndexOf($structure1, [StringComparison]::Ordinal) -ge 0) {
    throw "$Path already carries a version structure of 1.0"
}
$at = $text.IndexOf($structure0, [StringComparison]::Ordinal)
if ($at -lt 0) {
    throw "$Path carries no version structure"
}
$copy = New-Object byte[] 52
[Array]::Copy($bytes, $at, $copy, 0, 52)
$copy[6] = 1
$stream = [System.IO.File]::Open($Path, 'Append')
try {
    $stream.Write($copy, 0, $copy.Length)
}
finally {
    $stream.Dispose()
}

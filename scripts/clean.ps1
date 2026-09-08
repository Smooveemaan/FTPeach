#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess)]
param(
    # Keep native compilation caches when only generated reports/output need cleaning.
    [switch]$ArtifactsOnly
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$workspacePrefix = [System.IO.Path]::GetFullPath($workspace).TrimEnd('\') + '\'
$releaseTarget = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'FTPeachBuild'))

# Every path below is a build cache or generated output that the next build
# recreates; scripts/with-libsodium.ps1 decides which Cargo target directory a
# given command uses. Deliberately kept: .tools\libsodium-1.0.22-msvc (the
# verified archive copy that with-libsodium.ps1 initializes once and every
# Rust command depends on), .local, and node_modules.
$targets = [ordered]@{
    # Default Cargo target directory (dev, check, test, clippy).
    'src-tauri\target'          = Join-Path $workspace 'src-tauri\target'
    # Cargo target directory of `smoke-build` (with-libsodium.ps1).
    '.tools\smoke-target'       = Join-Path $workspace '.tools\smoke-target'
    # Cargo target directory of `build`: with-libsodium.ps1 redirects release
    # artifacts to this ASCII path because WiX 3 light.exe fails on Cyrillic
    # output paths.
    '%LOCALAPPDATA%\FTPeachBuild' = $releaseTarget
    # Vite output checked by scripts/checks/check-bundle-budget.ts.
    'dist'                      = Join-Path $workspace 'dist'
    # SBOM output of scripts/release/generate-sbom.ts.
    'release'                   = Join-Path $workspace 'release'
    # Playwright output (playwright.config.ts).
    'test-results'              = Join-Path $workspace 'test-results'
    'playwright-report'         = Join-Path $workspace 'playwright-report'
    # Tauri-generated schemas.
    'src-tauri\gen'             = Join-Path $workspace 'src-tauri\gen'
}

$freedBytes = 0
foreach ($entry in $targets.GetEnumerator()) {
    $label = $entry.Key
    if ($ArtifactsOnly -and $label -in @('src-tauri\target', '.tools\smoke-target', '%LOCALAPPDATA%\FTPeachBuild')) {
        continue
    }
    $path = [System.IO.Path]::GetFullPath($entry.Value)
    if (-not $path.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $path.Equals($releaseTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup target is outside the allowed directories: $path"
    }
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "skip    $label (not present)"
        continue
    }
    if ((Get-Item -LiteralPath $path -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Cleanup target must not be a symbolic link or junction: $path"
    }
    if (-not $PSCmdlet.ShouldProcess($path, 'Remove generated directory')) { continue }
    $size = (Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum).Sum
    if ($null -eq $size) { $size = 0 }
    # Individual files can be locked (rust-analyzer, a running dev build,
    # antivirus). Delete what is deletable and report the rest instead of
    # aborting the whole run.
    Remove-Item -LiteralPath $path -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $path) {
        $left = (Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue |
            Measure-Object Length -Sum).Sum
        if ($null -eq $left) { $left = 0 }
        $freedBytes += ($size - $left)
        Write-Warning ('{0}: {1:N1} MB left behind by locked files - close the app, dev server, or rust-analyzer and re-run.' -f $label, ($left / 1MB))
    }
    else {
        $freedBytes += $size
        Write-Host ('removed {0} ({1:N1} MB)' -f $label, ($size / 1MB))
    }
}

Write-Host ('Done. Freed {0:N2} GB.' -f ($freedBytes / 1GB))

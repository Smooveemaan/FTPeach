import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function msixName(version: string): string {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  return `FTPeach_${version}_x64.msix`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function appxManifest(
  version: string,
  identityName = process.env.MS_STORE_IDENTITY_NAME ?? 'Smooveemaan.FTPeach',
  publisher = process.env.MS_STORE_PUBLISHER ?? 'CN=Leonid Lozovskii',
  publisherDisplayName = process.env.MS_STORE_PUBLISHER_DISPLAY_NAME ?? 'Leonid Lozovskii',
): string {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity
    Name="${escapeXml(identityName)}"
    Publisher="${escapeXml(publisher)}"
    Version="${version}.0"
    ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>FTPeach</DisplayName>
    <PublisherDisplayName>${escapeXml(publisherDisplayName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily
      Name="Windows.Desktop"
      MinVersion="10.0.17763.0"
      MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application
      Id="FTPeach"
      Executable="FTPeach.exe"
      EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="FTPeach"
        Description="FTP, FTPS, and SFTP desktop client"
        BackgroundColor="#141312"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
}

function version(): string {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
    version: string;
  };
  return config.version;
}

export function findMakeAppx(): string {
  const kitsBin = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (existsSync(kitsBin)) {
    const versions = readdirSync(kitsBin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^10\.0\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const ver of versions) {
      const candidate = path.join(kitsBin, ver, 'x64', 'makeappx.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'makeappx.exe';
}

function resolveIcon(preferred: string, fallback: string): string {
  return existsSync(preferred) ? preferred : fallback;
}

export function stageLayout(
  releaseDir: string,
  layoutDir: string,
  of = version(),
  binaryPath = path.join(releaseDir, 'app.exe'),
) {
  rmSync(layoutDir, { recursive: true, force: true });
  mkdirSync(path.join(layoutDir, 'Assets'), { recursive: true });
  cpSync(binaryPath, path.join(layoutDir, 'FTPeach.exe'));
  writeFileSync(path.join(layoutDir, 'AppxManifest.xml'), appxManifest(of));
  cpSync(
    resolveIcon('src-tauri/icons/StoreLogo.png', 'src-tauri/icons/128x128.png'),
    path.join(layoutDir, 'Assets', 'StoreLogo.png'),
  );
  cpSync(
    resolveIcon('src-tauri/icons/Square44x44Logo.png', 'src-tauri/icons/32x32.png'),
    path.join(layoutDir, 'Assets', 'Square44x44Logo.png'),
  );
  cpSync(
    resolveIcon('src-tauri/icons/Square150x150Logo.png', 'src-tauri/icons/128x128.png'),
    path.join(layoutDir, 'Assets', 'Square150x150Logo.png'),
  );
  cpSync('LICENSE', path.join(layoutDir, 'LICENSE'));
  for (const resource of ['NOTICE', 'licenses', 'icons', 'ftpeach-update-version']) {
    const source = path.join(releaseDir, resource);
    if (existsSync(source)) {
      cpSync(source, path.join(layoutDir, resource), { recursive: true });
    }
  }
}

export function build(
  releaseDir: string,
  of = version(),
  binaryPath = path.join(releaseDir, 'app.exe'),
  run: typeof execFileSync = execFileSync,
): string {
  const msixDir = path.join(releaseDir, 'bundle', 'msix');
  const layoutDir = path.join(msixDir, 'layout');
  const msixPath = path.join(msixDir, msixName(of));
  rmSync(msixDir, { recursive: true, force: true });
  stageLayout(releaseDir, layoutDir, of, binaryPath);
  run(findMakeAppx(), ['pack', '/d', layoutDir, '/p', msixPath, '/o', '/nv'], {
    stdio: 'inherit',
  });
  rmSync(layoutDir, { recursive: true, force: true });
  return msixPath;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, releaseDirArg, binaryPathArg] = process.argv.slice(2);
  const releaseDir = releaseDirArg ?? process.env.FTPEACH_RELEASE_DIR ?? 'src-tauri/target/release';
  if (command === 'build') {
    console.log(build(releaseDir, version(), binaryPathArg ?? path.join(releaseDir, 'app.exe')));
  } else {
    console.error('Usage: msix.ts build [releaseDir] [binaryPath]');
    process.exit(1);
  }
}

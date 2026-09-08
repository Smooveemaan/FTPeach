import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outputDirectory = process.argv[2] ?? 'release/sbom';
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const packageLock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const cargoLock = await readFile('src-tauri/Cargo.lock', 'utf8');

type Component = {
  type: 'library';
  name: string;
  version: string;
  purl: string;
  'bom-ref': string;
};
const document = (name: string, components: Component[]) => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: { component: { type: 'application', name: 'FTPeach', version: packageJson.version } },
  components: components.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref'])),
  dependencies: components.map((component) => ({ ref: component['bom-ref'], dependsOn: [] })),
  properties: [{ name: 'ftpeach:ecosystem', value: name }],
});

const npmComponents = Object.entries(
  packageLock.packages as Record<string, { name?: string; version?: string }>,
)
  .filter(([location, value]) => location && value.version)
  .map(([location, value]) => {
    const name = value.name ?? location.slice(location.lastIndexOf('node_modules/') + 13);
    const encodedName = name.startsWith('@')
      ? name.slice(1).split('/').map(encodeURIComponent).join('/')
      : encodeURIComponent(name);
    const purl = `pkg:npm/${encodedName}@${value.version}`;
    return { type: 'library' as const, name, version: value.version!, purl, 'bom-ref': purl };
  });
const uniqueNpmComponents = [
  ...new Map(npmComponents.map((item) => [item['bom-ref'], item])).values(),
];

const cargoComponentsByReference = new Map<string, Component>();
for (const block of cargoLock.split(/\r?\n\[\[package\]\]\r?\n/).slice(1)) {
  const name = block.match(/^name = "([^"]+)"/m)?.[1];
  const version = block.match(/^version = "([^"]+)"/m)?.[1];
  if (!name || !version) continue;
  const purl = `pkg:cargo/${encodeURIComponent(name)}@${version}`;
  cargoComponentsByReference.set(purl, { type: 'library', name, version, purl, 'bom-ref': purl });
}
const cargoComponents = [...cargoComponentsByReference.values()];

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(
    path.join(outputDirectory, 'ftpeach-npm.cdx.json'),
    `${JSON.stringify(document('npm', uniqueNpmComponents), null, 2)}\n`,
  ),
  writeFile(
    path.join(outputDirectory, 'ftpeach-cargo.cdx.json'),
    `${JSON.stringify(document('cargo', cargoComponents), null, 2)}\n`,
  ),
]);
console.log(
  `Generated npm (${uniqueNpmComponents.length}) and Cargo (${cargoComponents.length}) CycloneDX SBOMs.`,
);

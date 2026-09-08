import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const sourceExtensions = new Set(['.ts', '.tsx']);

/** Read syntax nodes so comments and strings cannot invent or hide import edges. */
function importSpecifiers(file: string, contents: string): string[] {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    let value: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) value = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      value = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      value = node.argument.literal;
    if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)))
      specifiers.push(value.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

export function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

export function featureName(file: string, featuresRoot: string): string | null {
  const relative = path.relative(featuresRoot, file);
  return relative.startsWith('..') ? null : (relative.split(path.sep)[0] ?? null);
}

// The two files allowed to sit directly in `src/`. Everything else that lived
// there was two levels at once: `utils.ts` sat below the features that all
// imported it while `menus.ts` sat above them, and neither was covered by any
// rule, because the root fell through to `other`.
const entryPoints = new Set(['App.tsx', 'main.tsx']);

export function sourceArea(
  file: string,
  sourceRoot: string,
):
  | 'app'
  | 'shared'
  | 'components'
  | 'hooks'
  | 'shortcuts'
  | 'i18n'
  | 'platform'
  | 'features'
  | 'entry'
  | 'other' {
  const relative = path.relative(sourceRoot, file);
  const segments = relative.split(path.sep);
  const first = segments[0];
  if (
    first === 'app' ||
    first === 'shared' ||
    first === 'components' ||
    first === 'hooks' ||
    first === 'shortcuts' ||
    first === 'i18n' ||
    first === 'platform' ||
    first === 'features'
  ) {
    return first;
  }
  return segments.length === 1 ? 'entry' : 'other';
}

/** `src/` itself holds the entry points and nothing else. */
export function checkRootPlacement(file: string, sourceRoot: string): string[] {
  const relativeFile = path.relative(sourceRoot, file).split(path.sep).join('/');
  if (sourceArea(file, sourceRoot) === 'other')
    return [`${relativeFile} belongs to an unrecognized source area`];
  if (sourceArea(file, sourceRoot) !== 'entry' || entryPoints.has(relativeFile)) return [];
  return [
    `${relativeFile} sits in src/ itself, which holds only ${[...entryPoints].join(' and ')}`,
  ];
}

// `window.api` is installed by `platform/tauriApi.ts` and reached through
// `platform/api/index.ts`. Anywhere else it is a back door: an IPC dependency
// that leaves no import edge, so neither this checker nor a reader of the
// import list can see it. `app` is allowed because the composition root is
// where a global would legitimately be installed or read.
const globalApiPattern = /\bwindow\.api\b/;

export function checkGlobalApiAccess(file: string, sourceRoot: string, contents: string): string[] {
  if (!globalApiPattern.test(contents)) return [];
  const area = sourceArea(file, sourceRoot);
  if (area === 'platform' || area === 'app') return [];
  const relativeFile = path.relative(sourceRoot, file).split(path.sep).join('/');
  return [`${relativeFile} reaches window.api outside src/platform and src/app`];
}

export function resolvedImport(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const target = path.resolve(path.dirname(file), specifier);
  return (
    [
      target,
      `${target}.ts`,
      `${target}.tsx`,
      path.join(target, 'index.ts'),
      path.join(target, 'index.tsx'),
    ].find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) ?? target
  );
}

interface BoundaryContext {
  sourceRoot: string;
  featuresRoot: string;
  resolveImport?: typeof resolvedImport;
}

export function checkImportEdge(
  file: string,
  specifier: string,
  { sourceRoot, featuresRoot, resolveImport = resolvedImport }: BoundaryContext,
): string[] {
  const errors: string[] = [];
  const relativeFile = path.relative(sourceRoot, file);

  if (specifier === '@tauri-apps/api' || specifier.startsWith('@tauri-apps/api/')) {
    const inPlatform = sourceArea(file, sourceRoot) === 'platform';
    if (!inPlatform) {
      errors.push(`${relativeFile} imports ${specifier} directly outside src/platform`);
    }
  }

  const target = resolveImport(file, specifier);
  if (!target) return errors;

  // The entry points sit above `app` — they mount it — so they may reach it.
  const area = sourceArea(file, sourceRoot);
  if (sourceArea(target, sourceRoot) === 'app' && area !== 'app' && area !== 'entry') {
    errors.push(`${relativeFile} imports the app layer via ${specifier}`);
  }

  const owner = featureName(file, featuresRoot);
  const targetFeature = featureName(target, featuresRoot);

  if (targetFeature && targetFeature !== owner) {
    // `components` is leaf UI. Letting it import a feature made it a conduit:
    // `file-browser` really depended on `connections` through
    // `components/PaneSourceSwitcher.tsx`, an edge no reader of either
    // feature's imports could see.
    if (
      area === 'shared' ||
      area === 'platform' ||
      area === 'components' ||
      area === 'hooks' ||
      area === 'shortcuts' ||
      area === 'i18n'
    ) {
      errors.push(`${relativeFile} (${area}) imports feature ${targetFeature} via ${specifier}`);
    }

    // Every other cross-feature or app-to-feature import must go through
    // the feature's public index.ts/ui.ts, not an internal file.
    const featurePath = path
      .relative(path.join(featuresRoot, targetFeature), target)
      .split(path.sep)
      .join('/');
    const isPublicEntrypoint = ['index.ts', 'ui.ts'].includes(featurePath);
    if (!isPublicEntrypoint) {
      errors.push(`${relativeFile} imports ${targetFeature} internals via ${specifier}`);
    }
  }

  return errors;
}

export interface BoundaryCheckResult {
  errors: string[];
  featureCount: number;
}

/**
 * Contracts the file-level import graph down to features.
 *
 * Walking only direct feature→feature edges misses a dependency that passes
 * through a file belonging to no feature: `a → shared/x.ts → b` is an edge from
 * `a` to `b`, and a cycle built out of such hops was invisible. The walk
 * descends through every unowned file and stops the moment it reaches one owned
 * by another feature — that feature is the edge, its internals are not.
 */
function contractToFeatures(
  fileGraph: Map<string, Set<string>>,
  featuresRoot: string,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const file of fileGraph.keys()) {
    const owner = featureName(file, featuresRoot);
    if (!owner) continue;
    let dependencies = graph.get(owner);
    if (!dependencies) {
      dependencies = new Set<string>();
      graph.set(owner, dependencies);
    }

    const seen = new Set<string>([file]);
    const pending = [...(fileGraph.get(file) ?? [])];
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      const reached = featureName(next, featuresRoot);
      if (reached === owner) continue;
      if (reached) {
        dependencies.add(reached);
        continue;
      }
      pending.push(...(fileGraph.get(next) ?? []));
    }
  }

  return graph;
}

export function runBoundaryCheck(sourceRoot: string): BoundaryCheckResult {
  const featuresRoot = path.join(sourceRoot, 'features');
  const errors: string[] = [];
  const fileGraph = new Map<string, Set<string>>();
  const files = sourceFiles(sourceRoot);
  const known = new Set(files);

  for (const file of files) {
    const targets = new Set<string>();
    fileGraph.set(file, targets);

    const contents = fs.readFileSync(file, 'utf8');
    errors.push(...checkRootPlacement(file, sourceRoot));
    errors.push(...checkGlobalApiAccess(file, sourceRoot, contents));
    for (const specifier of importSpecifiers(file, contents)) {
      const target = resolvedImport(file, specifier);
      errors.push(
        ...checkImportEdge(file, specifier, {
          sourceRoot,
          featuresRoot,
          resolveImport: () => target,
        }),
      );
      if (target && known.has(target)) targets.add(target);
    }
  }

  const graph = contractToFeatures(fileGraph, featuresRoot);

  function visit(feature: string, visiting: Set<string>, visited: Set<string>): void {
    if (visiting.has(feature)) {
      errors.push(`feature dependency cycle detected at ${feature}`);
      return;
    }
    if (visited.has(feature)) return;
    visiting.add(feature);
    for (const dependency of graph.get(feature) ?? []) visit(dependency, visiting, visited);
    visiting.delete(feature);
    visited.add(feature);
  }

  const visited = new Set<string>();
  for (const feature of graph.keys()) visit(feature, new Set<string>(), visited);

  return { errors, featureCount: graph.size };
}

function main(): void {
  const sourceRoot = path.resolve('src');
  const { errors, featureCount } = runBoundaryCheck(sourceRoot);

  if (errors.length) {
    console.error(`Feature boundary check failed:\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }

  console.log(`Feature boundary check passed (${featureCount} features).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}

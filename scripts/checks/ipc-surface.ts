// Static parity check across the TypeScript <-> Rust IPC boundary:
// every command the renderer invokes must be registered in Rust, every
// registered command must have a caller, sensitive commands must be routed
// through `tauriApi.ts`'s authorization switch, and Tauri event names must
// match between Rust emitters and frontend listeners.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { isTestFile, splitInlineTests } from './rust-source.ts';

export interface FrontendIpcSurface {
  invokedCommands: Set<string>;
  explicitSensitiveCommands: Set<string>;
  sensitiveRoutedCommands: Set<string>;
  listenedEvents: Set<string>;
}

const SENSITIVE_PLUGIN_PREFIX = 'plugin:sensitive|';
const EXTERNAL_PLUGIN_PREFIX = /^plugin:[a-z0-9_-]+\|/;

// Protocol commands invoked directly with `plugin:sensitive|...` rather than
// through `tauriApi.ts`'s `switch (command)` authorization router.
const DIRECT_SENSITIVE_COMMANDS = new Set([
  'authorize_sensitive',
  'sensitive_confirmation_prompt',
  'sensitive_confirmation_ready',
  'respond_sensitive_confirmation',
]);

function stringLiterals(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return stringLiterals(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...stringLiterals(node.whenTrue), ...stringLiterals(node.whenFalse)];
  }
  return [];
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** Find local helpers in a file that forward one of their parameters straight to `invoke(param, ...)`. */
function findLocalInvokeWrappers(source: ts.SourceFile): Map<string, number> {
  const wrappers = new Map<string, number>();

  const inspectBody = (
    name: string,
    params: readonly ts.ParameterDeclaration[],
    body: ts.Node | undefined,
  ) => {
    if (!body) return;
    const paramIndex = new Map<string, number>();
    params.forEach((param, index) => {
      if (ts.isIdentifier(param.name)) paramIndex.set(param.name.text, index);
    });
    if (paramIndex.size === 0) return;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = calleeName(node.expression);
        if ((callee === 'invoke' || callee === 'rawInvoke') && node.arguments[0]) {
          const arg0 = node.arguments[0];
          if (ts.isIdentifier(arg0) && paramIndex.has(arg0.text)) {
            wrappers.set(name, paramIndex.get(arg0.text)!);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  };

  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      inspectBody(node.name.text, node.parameters, node.body);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      inspectBody(node.name.text, node.initializer.parameters, node.initializer.body);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return wrappers;
}

function recordCommand(raw: string, surface: FrontendIpcSurface): void {
  if (raw.startsWith(SENSITIVE_PLUGIN_PREFIX)) {
    const command = raw.slice(SENSITIVE_PLUGIN_PREFIX.length);
    surface.explicitSensitiveCommands.add(command);
    surface.invokedCommands.add(command);
    return;
  }
  if (EXTERNAL_PLUGIN_PREFIX.test(raw)) return;
  surface.invokedCommands.add(raw);
}

export function extractFrontendIpcFromSource(
  file: string,
  contents: string,
  surface: FrontendIpcSurface = {
    invokedCommands: new Set(),
    explicitSensitiveCommands: new Set(),
    sensitiveRoutedCommands: new Set(),
    listenedEvents: new Set(),
  },
): FrontendIpcSurface {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const wrappers = findLocalInvokeWrappers(source);
  const isTauriApi = path.basename(file) === 'tauriApi.ts';

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee === 'invoke' || callee === 'rawInvoke') {
        for (const cmd of stringLiterals(node.arguments[0])) recordCommand(cmd, surface);
      } else if (callee === 'voidOutcome') {
        for (const cmd of stringLiterals(node.arguments[1])) recordCommand(cmd, surface);
      } else if (callee === 'onEvent' || callee === 'listen') {
        for (const eventName of stringLiterals(node.arguments[0])) {
          surface.listenedEvents.add(eventName);
        }
      } else if (callee && wrappers.has(callee)) {
        const arg = node.arguments[wrappers.get(callee)!];
        for (const cmd of stringLiterals(arg)) recordCommand(cmd, surface);
      }
    } else if (
      isTauriApi &&
      ts.isSwitchStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'command'
    ) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          for (const cmd of stringLiterals(clause.expression)) {
            surface.sensitiveRoutedCommands.add(cmd);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return surface;
}

export function extractRustEventsFromSource(contents: string): Set<string> {
  const production = splitInlineTests(contents).production;
  if (!production.includes('Emitter')) return new Set();

  const constants = new Map<string, string>();
  for (const match of production.matchAll(
    /\bconst\s+([A-Z0-9_]+)\s*:\s*&str\s*=\s*"([^"]+)"\s*;/g,
  )) {
    constants.set(match[1]!, match[2]!);
  }

  const events = new Set<string>();
  const resolveExpr = (expr: string): string | null => {
    const trimmed = expr.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
    return constants.get(trimmed) ?? null;
  };

  // `.emit("event", ...)` or `.emit(EVENT_CONST, ...)`
  for (const match of production.matchAll(/\.emit\(\s*("[^"]+"|[A-Z][A-Z0-9_]*)\s*,/g)) {
    const name = resolveExpr(match[1]!);
    if (name) events.add(name);
  }
  // `.emit_to(target, "event", ...)` or `.emit_to(target, EVENT_CONST, ...)`
  for (const match of production.matchAll(
    /\.emit_to\(\s*[^,]+,\s*("[^"]+"|[A-Z][A-Z0-9_]*)\s*,/g,
  )) {
    const name = resolveExpr(match[1]!);
    if (name) events.add(name);
  }

  return events;
}

function listFiles(dir: string, predicate: (_file: string) => boolean): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(predicate);
}

export function collectWorkspaceIpcSurface(repoRoot: string): {
  frontend: FrontendIpcSurface;
  rustEvents: Set<string>;
} {
  const frontend: FrontendIpcSurface = {
    invokedCommands: new Set(),
    explicitSensitiveCommands: new Set(),
    sensitiveRoutedCommands: new Set(),
    listenedEvents: new Set(),
  };

  const platformFiles = listFiles(path.join(repoRoot, 'src', 'platform'), (file) =>
    /\.(?:ts|tsx)$/.test(file),
  );
  const smokeScript = path.join(repoRoot, 'src-tauri', 'assets', 'smoke_test.js');
  for (const file of [...platformFiles, smokeScript]) {
    extractFrontendIpcFromSource(file, readFileSync(file, 'utf8'), frontend);
  }

  const rustEvents = new Set<string>();
  const rustFiles = listFiles(
    path.join(repoRoot, 'src-tauri', 'src'),
    (file) => file.endsWith('.rs') && !isTestFile(file),
  );
  for (const file of rustFiles) {
    for (const eventName of extractRustEventsFromSource(readFileSync(file, 'utf8'))) {
      rustEvents.add(eventName);
    }
  }

  return { frontend, rustEvents };
}

function assertSetMatch(actual: Iterable<string>, expected: Iterable<string>, subject: string) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((entry) => !actualSet.has(entry)).sort();
  const extra = [...actualSet].filter((entry) => !expectedSet.has(entry)).sort();
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${subject}\n  missing: ${missing.join(', ') || '(none)'}\n  unexpected: ${extra.join(', ') || '(none)'}`,
  );
}

export function verifyIpcSurface(params: {
  appCommands: readonly string[];
  sensitiveCommands: readonly string[];
  frontend: FrontendIpcSurface;
  rustEvents: ReadonlySet<string>;
}): void {
  const { appCommands, sensitiveCommands, frontend, rustEvents } = params;
  const allRegistered = new Set([...appCommands, ...sensitiveCommands]);
  const sensitiveSet = new Set(sensitiveCommands);

  assertSetMatch(
    frontend.invokedCommands,
    allRegistered,
    'Frontend IPC invokes must match the commands registered in Rust (no typos or dead commands)',
  );

  const invalidSensitivePrefix = [...frontend.explicitSensitiveCommands]
    .filter((command) => !sensitiveSet.has(command))
    .sort();
  assert.deepEqual(
    invalidSensitivePrefix,
    [],
    `Explicit plugin:sensitive| invokes must target sensitive commands: ${invalidSensitivePrefix.join(', ')}`,
  );

  const expectedRouted = sensitiveCommands.filter(
    (command) => !DIRECT_SENSITIVE_COMMANDS.has(command),
  );
  assertSetMatch(
    frontend.sensitiveRoutedCommands,
    expectedRouted,
    'tauriApi.ts sensitive switch must cover every user-facing sensitive command',
  );

  assertSetMatch(
    frontend.listenedEvents,
    rustEvents,
    'Frontend Tauri event listeners must match the events emitted by Rust',
  );
}

import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * A preset ESLint no longer ships would otherwise drop its whole rule set
 * silently, leaving a green lint that checks less than it did.
 */
function presetRules(name: string, preset: { rules?: unknown } | undefined) {
  if (!preset?.rules)
    throw new Error(`ESLint preset "${name}" is missing; check the plugin version.`);
  return preset.rules as Record<string, unknown>;
}

export default [
  {
    ignores: [
      '.tools/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      'vendor/**',
      'src-tauri/target/**',
    ],
  },

  // Renderer (src/**) — ESM, browser globals, JSX/React.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        // Type-aware linting. Without it the rules that need type information
        // (no-floating-promises, no-misused-promises, …) silently never run —
        // and in an app whose entire job is async I/O, those are the rules
        // that matter most.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...presetRules('react/recommended', react.configs.flat.recommended),
      ...presetRules('react/jsx-runtime', react.configs.flat['jsx-runtime']),
      ...reactHooks.configs.recommended.rules,
      ...presetRules(
        'typescript-eslint/recommended-type-checked',
        tseslint.configs.recommendedTypeChecked[2],
      ),
      // Public hooks must declare their contract; applying the broad boundary
      // rule would also require unrelated component and utility annotations.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            ':matches(ExportNamedDeclaration, ExportDefaultDeclaration) > FunctionDeclaration[id.name=/^use[A-Z]/]:not([returnType])',
          message: 'Exported hooks must declare an explicit return type.',
        },
        {
          selector:
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=/^use[A-Z]/]:not([id.typeAnnotation]) > :matches(ArrowFunctionExpression, FunctionExpression):not([returnType])',
          message: 'Exported hooks must declare an explicit return type.',
        },
      ],
      'react/prop-types': 'off', // codebase doesn't use PropTypes anywhere
      // Every remaining suppression of this rule carries a written reason for
      // why including the dependency would produce wrong behaviour. `error`
      // rather than the preset's `warn` so that stays a deliberate act.
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // ignoreRestSiblings: this codebase's destructure-to-omit-secrets idiom
      // (`const { password, ...rest } = site`) deliberately leaves `password`
      // unused — it exists only to keep it out of `rest`.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-unused-expressions': 'off',
    },
    settings: {
      react: { version: 'detect' },
    },
  },

  // Tests — Node + node:test globals, either module system depending on extension.
  {
    files: ['test/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['test/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parser: tseslint.parser,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-redeclare': 'off',
    },
  },

  // Root TypeScript configs and scripts — Node, ESM.
  {
    files: ['*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
      parser: tseslint.parser,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // Prettier last — turns off any ESLint formatting rules that would
  // conflict with it; all formatting is Prettier's job, not ESLint's.
  prettier,
];

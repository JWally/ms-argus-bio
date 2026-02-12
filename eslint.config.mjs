import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import importX from 'eslint-plugin-import-x';
import prettier from 'eslint-config-prettier';

// Shared rules for sonarjs, unicorn, and import-x (applied to all TS/TSX)
const qualityRules = {
  // --- sonarjs: cognitive complexity & code smells ---
  'sonarjs/cognitive-complexity': ['error', 15],
  'sonarjs/no-duplicate-string': 'warn',
  'sonarjs/no-identical-functions': 'warn',

  // --- unicorn: modern JS best practices ---
  'unicorn/no-static-only-class': 'error',
  'unicorn/no-useless-undefined': 'error',
  'unicorn/no-unnecessary-await': 'error',
  'unicorn/no-useless-spread': 'error',
  'unicorn/no-useless-promise-resolve-reject': 'error',
  'unicorn/no-empty-file': 'error',
  'unicorn/no-useless-fallback-in-spread': 'error',
  'unicorn/no-lonely-if': 'error',
  'unicorn/no-array-for-each': 'warn',
  'unicorn/prefer-array-some': 'error',
  'unicorn/no-array-push-push': 'error',

  // --- import-x: import hygiene ---
  'import-x/no-duplicates': 'error',
  'import-x/no-cycle': ['warn', { maxDepth: 3 }],
  'import-x/order': [
    'warn',
    {
      groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
      'newlines-between': 'never',
    },
  ],

  // --- complexity guards ---
  complexity: ['error', 15],
  'max-depth': ['error', 4],
  'max-params': ['error', 5],
};

// Shared TS rules applied to all zones
const tsBaseRules = {
  ...typescript.configs.recommended.rules,
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/explicit-function-return-type': 'off',
  '@typescript-eslint/no-explicit-any': 'warn',
  'prefer-const': 'error',
  'no-var': 'error',
  // TypeScript handles no-undef natively; ESLint's version doesn't understand TS types/globals
  'no-undef': 'off',
};

// Shared plugins for all zones
const basePlugins = {
  '@typescript-eslint': typescript,
  sonarjs,
  unicorn,
  'import-x': importX,
};

export default [
  js.configs.recommended,
  prettier,
  {
    ignores: ['node_modules/', 'dist/', 'cdk.out/', '*.js', '*.cjs', '*.min.js', 'public/'],
  },
  // --- src: React/browser files ---
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        navigator: 'readonly',
        Navigator: 'readonly',
        Intl: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        URLSearchParams: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        crypto: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLImageElement: 'readonly',
        Image: 'readonly',
        CanvasRenderingContext2D: 'readonly',
        PointerEvent: 'readonly',
        MouseEvent: 'readonly',
        Event: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
      },
    },
    plugins: {
      ...basePlugins,
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      ...tsBaseRules,
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-console': 'warn',
      ...qualityRules,
      // Relax complexity for React components (JSX conditionals inflate counts)
      complexity: ['warn', 25],
      'sonarjs/cognitive-complexity': ['warn', 20],
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  // --- server: Lambda files ---
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        Buffer: 'readonly',
      },
    },
    plugins: basePlugins,
    rules: {
      ...tsBaseRules,
      'no-console': 'off',
      ...qualityRules,
    },
  },
  // --- cdk: CDK infra files ---
  {
    files: ['cdk/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
    },
    plugins: basePlugins,
    rules: {
      ...tsBaseRules,
      'no-console': 'warn',
      ...qualityRules,
    },
  },
  // --- scripts: tooling scripts ---
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
    },
    plugins: basePlugins,
    rules: {
      ...tsBaseRules,
      'no-console': 'off',
      ...qualityRules,
      // Relax for scripts
      complexity: ['warn', 25],
      'sonarjs/cognitive-complexity': ['warn', 25],
    },
  },
];

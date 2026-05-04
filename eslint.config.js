import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import anvil from 'eslint-plugin-anvil';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.claude/worktrees/**',
      'eslint.config.js',
      'vitest.config.ts',
      'drizzle.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      anvil,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      'max-depth': 'error',
      'max-lines': ['error', { max: 300, skipComments: true }],
      'max-lines-per-function': ['error', { max: 50, skipComments: true }],
      'max-nested-callbacks': 'error',
      'max-params': 'error',
      'max-statements': 'error',
      complexity: 'error',
      'anvil/no-excessive-optionals': 'error',
    },
  },
  {
    files: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      anvil,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'max-depth': ['error', 20],
      'max-lines': ['error', { max: 1500, skipComments: true }],
      'max-lines-per-function': ['error', { max: 250, skipComments: true }],
      'max-nested-callbacks': ['error', 50],
      'max-params': ['error', 15],
      'max-statements': ['error', 50],
      complexity: ['error', 100],
      'anvil/no-excessive-optionals': 'off',
    },
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/adapters',
                '**/adapters/**',
                '**/db',
                '**/db/**',
                '**/http',
                '**/http/**',
                '**/mcp',
                '**/mcp/**',
                '**/query',
                '**/query/**',
                '**/records',
                '**/records/**',
                '**/storage',
                '**/storage/**',
              ],
              message:
                'Use the Node subpath alias (#adapters, #db, #http, #mcp, #query, #records, #storage) instead of a relative cross-module path. Cross-module imports must go through package.json "imports"; this makes module dependencies obvious in any diff and physically blocks reaching past barrels.',
            },
          ],
        },
      ],
    },
  },
  prettierConfig,
);

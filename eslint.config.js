import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/drizzle/**',
      '**/next-env.d.ts',
      // Desktop build output: bundled daemon, exported console, and a packaged
      // Electron app. All generated, none of it ours to lint.
      'apps/desktop/build/**',
      'apps/desktop/dist/**',
      'apps/console/.next-desktop/**',
      'apps/console/out/**',
      '**/*.config.js',
      '**/*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts: build pipeline and the icon generator. TypeScript
    // files get these from @types/node; these do not.
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': [
        'error',
        {
          // LAW 2 — structural ban on permission bypass.
          selector: "Literal[value='bypassPermissions']",
          message:
            'HELM LAW 2: bypassPermissions is forbidden. Never bypass the permission callback.',
        },
        {
          selector: "Literal[value=/dangerously-skip-permissions/]",
          message:
            'HELM LAW 2: --dangerously-skip-permissions is forbidden anywhere in Helm.',
        },
      ],
    },
  },
);

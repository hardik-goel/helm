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
      '**/*.config.js',
      '**/*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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

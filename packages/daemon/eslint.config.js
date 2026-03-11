import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-inner-declarations': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      semi: 'off',
    },
  },
  { ignores: ['dist/**', 'build.js', '**/*.d.ts'] },
);

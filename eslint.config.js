import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, reactHooks.configs.flat['recommended-latest']],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Platform seam guard: raw platform/storage APIs may only be touched inside
    // src/platform/** and src/store/persistence.ts — everything else goes through the seam.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/platform/**', 'src/store/persistence.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='window'][property.name='Telegram']",
          message: 'Access Telegram APIs through src/platform/* only.',
        },
        {
          selector: "MemberExpression[object.name='localStorage'], CallExpression[callee.object.name='localStorage']",
          message: 'Access storage through src/store/persistence.ts only.',
        },
        {
          selector: "MemberExpression[object.name='window'][property.name='localStorage']",
          message: 'Access storage through src/store/persistence.ts only.',
        },
      ],
    },
  },
);

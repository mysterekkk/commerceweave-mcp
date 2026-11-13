import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'scripts'] },
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }], 'no-console': 'error' } },
  { files: ['tests/**', 'src/cli/**'], rules: { 'no-console': 'off' } }
);

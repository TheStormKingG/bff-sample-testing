import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // IGNORED HERE DOES NOT MEAN UNCHECKED.
    //
    // supabase/functions/** is Deno, not browser or Node: those modules use
    // `Deno.serve`, `Deno.env` and `npm:`/`jsr:` specifiers, none of which
    // this config knows about, so linting them from here reports undefined
    // globals and unresolvable imports — noise that buries real findings.
    //
    // Those modules are type-checked AND linted by Deno itself, in
    // .github/workflows/ci.yml ("Typecheck Supabase Edge Functions" and
    // "Lint Supabase Edge Functions"), which is part of the gate
    // deploy-pages.yml calls before it publishes anything. If you ever delete
    // those two steps, delete this ignore as well: without them this line
    // leaves ~8,500 lines of server-side logic with no static analysis at all,
    // which is the state this repository was genuinely in before they existed.
    ignores: ['dist', 'coverage', 'playwright-report', 'test-results', 'supabase/functions/**'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
);

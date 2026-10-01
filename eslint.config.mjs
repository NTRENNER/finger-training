import fs from 'node:fs';
import globals from 'globals';
import react from 'eslint-plugin-react';
import hooks from 'eslint-plugin-react-hooks';
import a11y from 'eslint-plugin-jsx-a11y';
import imports from 'eslint-plugin-import';
import jest from 'eslint-plugin-jest';
import testingLibrary from 'eslint-plugin-testing-library';

// Carry forward the established CRA rules without depending on react-scripts.
const rules = JSON.parse(fs.readFileSync(new URL('./eslint.rules.json', import.meta.url), 'utf8'));
export default [
  { ignores: ['build/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest', sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { react, 'react-hooks': hooks, 'jsx-a11y': a11y, import: imports, jest, 'testing-library': testingLibrary },
    settings: { react: { version: 'detect' } },
    rules: rules.app,
  },
  {
    files: ['src/**/*.test.{js,jsx}', 'src/**/__tests__/**/*.{js,jsx}', 'src/setupTests.js'],
    languageOptions: { globals: globals.jest },
    rules: rules.tests,
  },
  { files: ['src/**/*.worker.js'], languageOptions: { globals: globals.worker } },
];

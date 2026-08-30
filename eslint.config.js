import prettier from 'eslint-config-prettier'
import base from './config/lint/base.js'

export default [
  // Benchmark fixtures and the create scaffold are standalone apps with their own tsconfig.
  { ignores: ['bench/fixtures/**', 'src/cli/template/**'] },
  ...base,
  {
    files: ['**/*.js', '**/*.ts', '**/*.tsx'],
    rules: {
      'turbo/no-undeclared-env-vars': [
        'error',
        {
          allowList: [
            '^NEXT_DEBUG_BUILD$',
            '^NEXT_FONT_GOOGLE_MOCKED_RESPONSES$',
            '^PNEXT_FONT_GOOGLE_METADATA$',
            '^PNEXT_CONFIG_FAST$',
          ],
        },
      ],
    },
  },
  prettier,
]

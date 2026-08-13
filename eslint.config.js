const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const rulesDirPlugin = require('eslint-plugin-rulesdir');

rulesDirPlugin.RULES_DIR = './eslint-rules';

module.exports = [
	{
		ignores: ['**/node_modules/**', '**/dist/**', '**/*.js.map', 'coverage/**']
	},
	{
		files: ['**/*.ts'],

		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module'
			},
			globals: {
				process: 'readonly',
				console: 'readonly',
				__dirname: 'readonly',
				__filename: 'readonly',
				module: 'readonly',
				require: 'readonly',
				Buffer: 'readonly',
				setTimeout: 'readonly',
				setInterval: 'readonly',
				clearTimeout: 'readonly',
				clearInterval: 'readonly'
			}
		},

		plugins: {
			'@typescript-eslint': tsPlugin,
			rulesdir: rulesDirPlugin
		},

		rules: {
			...tsPlugin.configs.recommended.rules,

			// Matched to the template estate: these are off there and fighting them
			// would make this codebase read differently from its siblings.
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-namespace': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
			'no-inner-declarations': 'off',
			'prefer-const': 'off',
			'no-mixed-spaces-and-tabs': 'off',

			// THE security rule. CLAUDE.md §2 made mechanical.
			// A clean lint run means little beyond this one — which is exactly what the
			// template says about its own `no-direct-db-instance`.
			'rulesdir/no-generated-sql-outside-guard': 'error'
		}
	}
];

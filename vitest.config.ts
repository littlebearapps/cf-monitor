import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/cli/**/*.ts'],
			thresholds: {
				statements: 60,
				branches: 60,
				functions: 60,
				lines: 60,
			},
		},
	},
});

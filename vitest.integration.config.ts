import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['tests/integration/**/*.test.ts'],
		testTimeout: 120_000,
		hookTimeout: 180_000,
		globalSetup: ['tests/integration/setup.ts'],
		sequence: {
			sequential: true,
		},
	},
});

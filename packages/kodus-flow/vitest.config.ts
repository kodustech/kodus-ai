import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { configDefaults } from 'vitest/config';

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        // aqui diz pro Vitest usar seu tsconfig de testes
        ...configDefaults,
        globals: true,
        environment: 'node',
        include: ['**/*.test.ts', '**/*.spec.ts'],
        // Configurações para não ficar em watch mode
        watch: false,
        // Setup global para carregar .env
        setupFiles: ['./tests/setup.ts'],

        // Configuração de timeouts
        testTimeout: process.env.CI ? 60000 : 30000, // 60s para CI/CD, 30s para desenvolvimento
        hookTimeout: 10000, // 10 segundos para hooks (before/after)

        // Configurações específicas para diferentes tipos de teste
        pool: 'threads',
        poolOptions: {
            threads: {
                singleThread: false,
                isolate: true,
                maxThreads: 4,
                minThreads: 1,
            },
        },

        // Configurações para testes lentos
        slowTestThreshold: 5000, // 5 segundos

        // Configurações de retry para testes flaky
        retry: process.env.CI ? 2 : 0,

        // Configurações para debugging
        logHeapUsage: true,

        // Configurações para testes de integração
        sequence: {
            concurrent: true,
            shuffle: false,
        },
    },
});

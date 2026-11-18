import { readFileSync } from 'fs';
import { join } from 'path';

import { isTestCode, ROOT, sources } from '../testing/source-scan';

// Config is read once at boot into typed config (architecture review, TS
// finding 10): only the loaders and the boot entry points read the process
// environment. Domain, adapter and cron code takes its values from them.

/** The files that may read it, and why. */
const READERS: Record<string, string> = {
    'apps/runtime/src/shared/config.ts': 'the worker, hub and edge loaders',
    'apps/runtime/src/shared/observability/otel.ts': 'tracing starts before Nest and reads the standard OTEL_* variables',
    'apps/runtime/src/shared/observability/resource.ts': 'the OTel resource of that same boot step',
    'libs/runtime/api/infrastructure/runtime-api.config.ts': "the API's loaders",
    'libs/runtime/api/infrastructure/runtime-cron-schedules.ts': '@Cron takes its schedule when the class is declared',
    'libs/runtime/api/infrastructure/openbao-secret-vault.adapter.ts': 'loadOpenBaoSecretVaultConfig, called once by the module factory',
    'libs/runtime/api/infrastructure/http-env-session.client.ts': 'loadEnvSessionClientConfig, called once by the module factory',
    'libs/runtime/api/infrastructure/dev-stub-git.adapter.ts': 'devGitStubFile, the dev-only Git stub switch read at module build',
    'libs/runtime-publish/runtime-feature.ts': "kodyRuntimeEnabledInThisProcess, the product process's RUNTIME_ENABLED switch for its crons and controllers",
    'libs/runtime-publish/runtime-publish.module.ts': 'composition root: API_FRONTEND_URL and RUNTIME_PREVIEW_DOMAIN at module build',
};

/** apps/runtime and the Runtime libs, and the Runtime parts of the product API and worker. */
function runtimeSources(): string[] {
    const product = [...sources('apps/api/src'), ...sources('apps/worker/src')].filter((path) => /\/runtime[^/]*\//.test(path));
    return [...sources('apps/runtime/src'), ...sources('libs/runtime'), ...sources('libs/runtime-publish'), ...product].filter((path) => !isTestCode(path));
}

export function readsProcessEnv(text: string): boolean {
    return text.split('\n').some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /\bprocess\.env\b/.test(line));
}

describe('process environment reads stay in the config loaders', () => {
    const files = runtimeSources();

    it('scans the Runtime sources, including the product worker and API parts', () => {
        expect(files).toContain('libs/runtime/api/infrastructure/runtime-webhook-reconciler.cron.ts');
        expect(files.some((path) => path.startsWith('apps/worker/src/'))).toBe(true);
    });

    it('no other Runtime file reads the process environment', () => {
        const readers = files.filter((path) => readsProcessEnv(readFileSync(join(ROOT, path), 'utf8')));
        expect(readers.filter((path) => !(path in READERS))).toEqual([]);
    });

    it('every allowed reader still exists and still reads it', () => {
        for (const path of Object.keys(READERS)) expect(readsProcessEnv(readFileSync(join(ROOT, path), 'utf8'))).toBe(true);
    });

    it('flags a read in code and ignores one in a comment', () => {
        expect(readsProcessEnv('const cron = process.env.RUNTIME_CRON_X;')).toBe(true);
        expect(readsProcessEnv('// process.env.RUNTIME_CRON_X is read by the loader')).toBe(false);
    });
});

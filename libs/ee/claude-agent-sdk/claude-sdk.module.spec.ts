jest.mock('@libs/ee/configs/environment', () => ({ environment: { API_CLOUD_MODE: false } }));

import { encrypt } from '@libs/common/utils/crypto';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { getClaudeSdkExecutors, withSdkInfraFallback } from '@libs/llm/sdk-executor-registry';
import { environment } from '@libs/ee/configs/environment';

import { ClaudeSdkLifecycle, licensedExecutors, registerClaudeSdk, unregisterClaudeSdk } from './claude-sdk.module';
import { createClaudeSdkExecutors } from './executors';
import { SdkGateway } from './gateway/server';
import { SdkProcessPool } from './process-pool';
import { loadSdkRuntime } from './sdk-runtime';

const claude = { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: encrypt('k') } as unknown as NormalizedModel;

describe('ClaudeSdkModule', () => {
    afterEach(() => (environment as any).API_CLOUD_MODE = false);

    it('cloud: registers the executors for every organization', async () => {
        const parts = registerClaudeSdk({ cloud: true, licensed: async () => false });
        const ex = getClaudeSdkExecutors()!;
        expect(ex.eligible(claude)).toBe(true);
        const runLoop = jest.fn(async () => 'sdk');
        const raw = createClaudeSdkExecutors({ pool: parts.pool, runtime: loadSdkRuntime });
        expect(Object.keys(ex).sort()).toEqual(Object.keys(raw).sort());
        void runLoop;
        await unregisterClaudeSdk(parts);
        expect(getClaudeSdkExecutors()).toBeUndefined();
    });

    it('self-hosted: a licensed organization runs on the SDK, an unlicensed one falls back quietly to today’s path', async () => {
        const base = { eligible: () => true, runLoop: jest.fn(async () => 'sdk'), runOneShot: jest.fn(async () => 'sdk' as any), isInfraFailure: (e: unknown) => (e as any)?.name === 'ClaudeSdkInfraError' };
        const ex = licensedExecutors(base, async (org) => org === 'licensed-org');
        const run = (organizationId: string) =>
            withSdkInfraFallback({ executors: ex, runSdk: () => ex.runLoop({ organizationId } as any), runAiSdk: async () => 'ai', started: () => false, runName: 'r', organizationId, slot: claude });
        expect(await run('licensed-org')).toBe('sdk');
        expect(await run('community-org')).toBe('ai');
        expect(base.runLoop).toHaveBeenCalledTimes(1);
        await expect(ex.runOneShot({ organizationId: 'community-org' } as any)).rejects.toMatchObject({ reason: 'unlicensed', expected: true });
    });

    it('lifecycle: registers on init with the license service, and shutdown aborts live sessions and frees the port', async () => {
        const license = { validateOrganizationLicense: jest.fn(async ({ organizationId }: any) => ({ valid: organizationId === 'org-ok' })) };
        const lifecycle = new ClaudeSdkLifecycle(license as any);
        lifecycle.onModuleInit();
        const ex = getClaudeSdkExecutors()!;
        expect(ex).toBeDefined();
        await expect(ex.runLoop({ organizationId: 'org-no', slot: claude } as any)).rejects.toMatchObject({ reason: 'unlicensed' });
        expect(license.validateOrganizationLicense).toHaveBeenCalledWith({ organizationId: 'org-no' });

        // A live session at shutdown is aborted, the gateway closes.
        const parts = (lifecycle as any).parts as { gateway: SdkGateway; pool: SdkProcessPool };
        const live = parts.pool
            .withSession(
                { resolved: { model: 'claude-sonnet-5-5', route: { format: 'anthropic', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', auth: 'x-api-key', firstParty: true } }, envelope: {} },
                (s) => new Promise((_r, reject) => s.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')))),
            )
            .catch((e: Error) => e.message);
        await new Promise((r) => setTimeout(r, 20));
        const origin = parts.gateway.origin;
        await lifecycle.onApplicationShutdown();
        expect(await live).toBe('aborted');
        expect(getClaudeSdkExecutors()).toBeUndefined();
        await expect(fetch(`${origin}/s/x`)).rejects.toThrow();
    });
});

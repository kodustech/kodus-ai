import { DEV_SECRET_SEAL_KEY_HEX } from '../testing/dev-seal-key';
import { loadRuntimeConfig, loadSetupConfig, loadWorkerConfig } from './config';
import { DEFAULT_MAX_TOKENS_PER_RUN } from '@libs/runtime/contracts/limits';
import { signUploadGrant } from '@libs/runtime/contracts/evidence';
import { UploadGrantSchema } from '@libs/runtime/protocol/messages';

describe('runtime config', () => {
    it.each([
        'http://host.orb.internal:3420/',
        'http://169.254.169.254/',
        'file:///PRIVATE_SENTINEL',
        'https://user:PRIVATE_SENTINEL@evidence.example.test/',
        'http://localhost:3420/base?token=PRIVATE_SENTINEL',
        'https://evidence.example.test/#PRIVATE_SENTINEL',
    ])(
        'refuses an upload base that cannot produce a valid cell grant without reflecting its value',
        (uploadUrl) => {
            const env = {
                RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX,
                RUNTIME_EVIDENCE_UPLOAD_URL: uploadUrl,
            };
            expect(() => loadWorkerConfig(env)).toThrow(
                /RUNTIME_EVIDENCE_UPLOAD_URL/,
            );
            try {
                loadWorkerConfig(env);
            } catch (e) {
                expect((e as Error).message).not.toContain(uploadUrl);
                expect((e as Error).message).not.toContain('PRIVATE_SENTINEL');
            }
        },
    );

    it.each([
        'https://evidence.example.test/storage/',
        'http://localhost:3420/',
        'http://127.0.0.1:3420/',
        'http://runtime-evidence:3420/',
    ])('accepts existing grant policy for %s', (uploadUrl) => {
        const config = loadWorkerConfig({
            RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX,
            RUNTIME_EVIDENCE_UPLOAD_URL: uploadUrl,
        });
        expect(config.evidence.uploadUrl).toBe(uploadUrl);
        const grant = signUploadGrant({
            baseUrl: config.evidence.uploadUrl!,
            organizationId: 'config-check',
            runId: 'config-check',
            side: 'base',
            stepId: '00000000-0000-4000-8000-000000000000',
            type: 'logs',
            secret: '0'.repeat(32),
            nonce: 'configuration-check',
            ttlSeconds: 60,
        });
        expect(UploadGrantSchema.safeParse(grant).success).toBe(true);
    });

    it('keeps uploads absent when no upload base was configured', () => {
        const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
        expect(loadWorkerConfig(base).evidence.uploadUrl).toBeUndefined();
        expect(
            loadWorkerConfig({ ...base, RUNTIME_EVIDENCE_UPLOAD_URL: '' })
                .evidence.uploadUrl,
        ).toBeUndefined();
    });

    it('keeps round snapshots on unless RUNTIME_ROUND_SNAPSHOTS is 0, and refuses any other value', () => {
        const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
        expect(loadWorkerConfig(base).roundSnapshots).toBe(true);
        expect(loadWorkerConfig({ ...base, RUNTIME_ROUND_SNAPSHOTS: '0' }).roundSnapshots).toBe(false);
        expect(loadWorkerConfig({ ...base, RUNTIME_ROUND_SNAPSHOTS: '1' }).roundSnapshots).toBe(true);
        expect(() => loadWorkerConfig({ ...base, RUNTIME_ROUND_SNAPSHOTS: 'true' })).toThrow(/RUNTIME_ROUND_SNAPSHOTS must be 0 or 1/);
    });

    it('keeps durable admission opt-in and bounds pending input by counts and bytes', () => {
        const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
        expect((loadWorkerConfig(base) as any).durableAdmission).toBe(false);
        const config = loadWorkerConfig({
            ...base,
            RUNTIME_DURABLE_ADMISSION: '1',
            RUNTIME_GLOBAL_CONCURRENCY: '3',
            RUNTIME_ORG_CONCURRENCY: '2',
        }) as any;
        expect(config.durableAdmission).toBe(true);
        expect(config.admission).toMatchObject({
            globalWaiting: 1000,
            perOrgWaiting: 100,
            globalExecuting: 3,
            perOrgExecuting: 2,
            maxPayloadBytes: 20 * 1024 * 1024,
            globalBacklogBytes: 256 * 1024 * 1024,
            orgBacklogBytes: 64 * 1024 * 1024,
        });
        expect(() =>
            loadWorkerConfig({ ...base, RUNTIME_DURABLE_ADMISSION: 'maybe' }),
        ).toThrow(/RUNTIME_DURABLE_ADMISSION/);
        expect(() =>
            loadWorkerConfig({ ...base, RUNTIME_ADMISSION_RETRY_MS: '0' }),
        ).toThrow(/RUNTIME_ADMISSION_RETRY_MS/);
        expect(() =>
            loadWorkerConfig({
                ...base,
                RUNTIME_DURABLE_ADMISSION: '1',
                RUNTIME_SWEEPER: 'false',
            }),
        ).toThrow(/RUNTIME_SWEEPER/);
        expect(
            loadWorkerConfig({ ...base, RUNTIME_GLOBAL_CONCURRENCY: '1' })
                .admission.perOrgExecuting,
        ).toBe(1);
    });
    it('runs 4 setups across the app and 10 workflows per replica unless set, never above the global limit', () => {
        const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
        const c = loadWorkerConfig(base);
        expect([c.setupConcurrency, c.workerConcurrency, c.admission.globalSetups]).toEqual([4, 10, 4]);
        const small = loadWorkerConfig({ ...base, RUNTIME_GLOBAL_CONCURRENCY: '3' });
        expect([small.setupConcurrency, small.workerConcurrency]).toEqual([3, 3]);
        expect(loadWorkerConfig({ ...base, RUNTIME_SETUP_CONCURRENCY: '1', RUNTIME_WORKER_CONCURRENCY: '20' }).workerConcurrency).toBe(20);
        for (const [name, bad] of [['RUNTIME_SETUP_CONCURRENCY', '0'], ['RUNTIME_WORKER_CONCURRENCY', '21'], ['RUNTIME_WORKER_CONCURRENCY', '0']])
            expect(() => loadWorkerConfig({ ...base, [name]: bad })).toThrow(new RegExp(name));
    });
    it("runs 2 setups of one organization at once unless set, between 1 and 8", () => {
        const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
        expect(loadWorkerConfig(base).setupPerOrg).toBe(2);
        expect(loadWorkerConfig({ ...base, RUNTIME_SETUP_PER_ORG: '8' }).setupPerOrg).toBe(8);
        for (const bad of ['0', '9', '1.5'])
            expect(() => loadWorkerConfig({ ...base, RUNTIME_SETUP_PER_ORG: bad })).toThrow(/RUNTIME_SETUP_PER_ORG/);
    });

    it('requires an explicit worker release in production and uses development only outside production', () => {
        const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
        expect(loadWorkerConfig(base).releaseVersion).toBe('development');
        expect(
            loadWorkerConfig({
                ...base,
                RUNTIME_RELEASE_VERSION: 'x'.repeat(128),
            }).releaseVersion,
        ).toHaveLength(128);
        for (const production of [
            { NODE_ENV: 'production' },
            { RUNTIME_PRODUCTION_IMAGE: '1' },
        ]) {
            expect(() => loadWorkerConfig({ ...base, ...production })).toThrow(
                /RUNTIME_RELEASE_VERSION/,
            );
            expect(
                loadWorkerConfig({
                    ...base,
                    ...production,
                    // The production image refuses the dev key (test below).
                    RUNTIME_SECRET_SEAL_KEY: 'a1'.repeat(32),
                    RUNTIME_RELEASE_VERSION: 'runtime-e968eceb5',
                    RUNTIME_EXECUTOR_ID: 'runtime-worker-0',
                }).releaseVersion,
            ).toBe('runtime-e968eceb5');
        }
    });

    it('validates release identities without reflecting invalid input', () => {
        const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
        for (const value of [
            '',
            ' ',
            'release/SECRET',
            'release\nSECRET',
            'release\n',
            'x'.repeat(129),
        ]) {
            expect(() =>
                loadWorkerConfig({ ...base, RUNTIME_RELEASE_VERSION: value }),
            ).toThrow(/RUNTIME_RELEASE_VERSION/);
            try {
                loadWorkerConfig({ ...base, RUNTIME_RELEASE_VERSION: value });
            } catch (e) {
                expect((e as Error).message).not.toContain('SECRET');
            }
        }
    });

    // DBOS recovers PENDING workflows by executor id, and every replica without one is 'local'.
    it('a production worker refuses to start without its own DBOS executor id', () => {
        const prod = { NODE_ENV: 'production', RUNTIME_RELEASE_VERSION: 'r1', RUNTIME_SECRET_SEAL_KEY: 'a1'.repeat(32) };
        expect(() => loadWorkerConfig(prod)).toThrow(/RUNTIME_EXECUTOR_ID \(or DBOS__VMID\) is required in production/);
        expect(() => loadWorkerConfig({ ...prod, DBOS__VMID: 'local' })).toThrow(/not 'local'/);
        expect(() => loadWorkerConfig({ ...prod, RUNTIME_EXECUTOR_ID: 'a', DBOS__VMID: 'b' })).toThrow(/disagree/);
        expect(() => loadWorkerConfig({ ...prod, RUNTIME_EXECUTOR_ID: 'worker/0' })).toThrow(/RUNTIME_EXECUTOR_ID must be/);
        expect(loadWorkerConfig({ ...prod, RUNTIME_EXECUTOR_ID: 'runtime-worker-0' }).executorId).toBe('runtime-worker-0');
        expect(loadWorkerConfig({ ...prod, DBOS__VMID: 'runtime-worker-1' }).executorId).toBe('runtime-worker-1');
        expect(loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX }).executorId).toBeUndefined();
    });

    it('gives each org 10000 machine minutes a day unless RUNTIME_MACHINE_MINUTES_PER_ORG_DAY says otherwise, 0 meaning unlimited', () => {
        expect(loadRuntimeConfig({}).machineMinutesPerOrgDay).toBe(10_000);
        expect(loadRuntimeConfig({ RUNTIME_MACHINE_MINUTES_PER_ORG_DAY: '0' }).machineMinutesPerOrgDay).toBe(0);
        expect(loadRuntimeConfig({ RUNTIME_MACHINE_MINUTES_PER_ORG_DAY: '600' }).machineMinutesPerOrgDay).toBe(600);
        expect(() => loadRuntimeConfig({ RUNTIME_MACHINE_MINUTES_PER_ORG_DAY: '-1' })).toThrow(/RUNTIME_MACHINE_MINUTES_PER_ORG_DAY/);
    });

    it("admits a sandbox that asks no size at 2048 MB on a cell that names none, unless RUNTIME_SANDBOX_MEMORY_MB says otherwise", () => {
        expect(loadRuntimeConfig({}).sandboxMemoryMb).toBe(2_048);
        expect(loadRuntimeConfig({ RUNTIME_SANDBOX_MEMORY_MB: '4096' }).sandboxMemoryMb).toBe(4_096);
        expect(() => loadRuntimeConfig({ RUNTIME_SANDBOX_MEMORY_MB: '100' })).toThrow(/RUNTIME_SANDBOX_MEMORY_MB/);
    });

    it('separates the internal listener from the public one', () => {
        const c = loadRuntimeConfig({ RUNTIME_HUB_PORT: '3410' });
        expect(c.internalPort).toBe(3411);
        expect(() =>
            loadRuntimeConfig({
                RUNTIME_HUB_PORT: '3410',
                RUNTIME_HUB_INTERNAL_PORT: '3410',
            }),
        ).toThrow(/must differ/);
    });

    it('refuses the test-only and insecure switches in the production image', () => {
        const plaintext = {
            RUNTIME_TEST_ONLY_PLAINTEXT: '1',
            RUNTIME_INTERNAL_TOKEN: 'a-long-enough-token',
        };
        expect(() => loadRuntimeConfig(plaintext)).not.toThrow();
        expect(() =>
            loadRuntimeConfig({ ...plaintext, NODE_ENV: 'production' }),
        ).toThrow(/RUNTIME_TEST_ONLY_PLAINTEXT/);
        expect(() =>
            loadRuntimeConfig({
                RUNTIME_PRODUCTION_IMAGE: '1',
                RUNTIME_DEV_ALLOW_INSECURE_CELLS: '1',
            }),
        ).toThrow(/RUNTIME_DEV_ALLOW_INSECURE_CELLS/);
        expect(() =>
            loadRuntimeConfig({
                RUNTIME_PRODUCTION_IMAGE: '1',
                RUNTIME_ENV_DRIVER: 'fake',
            }),
        ).toThrow(/RUNTIME_ENV_DRIVER=fake/);
    });

    it('has no default shared tokens: plaintext mode needs an explicit, long internal token', () => {
        expect(() =>
            loadRuntimeConfig({ RUNTIME_TEST_ONLY_PLAINTEXT: '1' }),
        ).toThrow(/RUNTIME_INTERNAL_TOKEN is required/);
        expect(() =>
            loadRuntimeConfig({
                RUNTIME_TEST_ONLY_PLAINTEXT: '1',
                RUNTIME_INTERNAL_TOKEN: 'short',
            }),
        ).toThrow(/16 characters/);
        expect(
            loadRuntimeConfig({
                RUNTIME_TEST_ONLY_PLAINTEXT: '1',
                RUNTIME_INTERNAL_TOKEN: 'a-long-enough-token',
            }).testOnlyPlaintext!.cellTokens,
        ).toEqual({});
    });

    it('writes the Run stream to Postgres unless told file', () => {
        expect(loadRuntimeConfig({}).streamStore).toBe('postgres');
        expect(
            loadRuntimeConfig({ RUNTIME_STREAM_STORE: 'file' }).streamStore,
        ).toBe('file');
        expect(() =>
            loadRuntimeConfig({ RUNTIME_STREAM_STORE: 'disk' }),
        ).toThrow();
    });

    it('the worker keeps evidence on the volume unless told s3, and s3 needs its bucket and keys', () => {
        const base = { RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX };
        expect(loadWorkerConfig(base).evidence).toMatchObject({
            store: 'file',
        });
        expect(() =>
            loadWorkerConfig({ ...base, RUNTIME_EVIDENCE_STORE: 's3' }),
        ).toThrow(/RUNTIME_EVIDENCE_S3_BUCKET/);
        const c = loadWorkerConfig({
            ...base,
            RUNTIME_EVIDENCE_STORE: 's3',
            RUNTIME_EVIDENCE_S3_BUCKET: 'kodus-evidence',
            RUNTIME_EVIDENCE_S3_ACCESS_KEY_ID: 'AKIDWORKER',
            RUNTIME_EVIDENCE_S3_SECRET_ACCESS_KEY: 'worker-secret-value-000000',
        });
        expect(c.evidence.s3).toMatchObject({
            bucket: 'kodus-evidence',
            credentials: { accessKeyId: 'AKIDWORKER' },
        });
        expect(JSON.stringify(c)).not.toContain('worker-secret-value-000000');
    });

    it('fails fast on a malformed number or JSON value', () => {
        expect(() =>
            loadRuntimeConfig({ RUNTIME_ORG_CONCURRENCY: 'two' }),
        ).toThrow(/RUNTIME_ORG_CONCURRENCY/);
        expect(() =>
            loadRuntimeConfig({ RUNTIME_MANAGED_CELLS: '{oops' }),
        ).toThrow(/RUNTIME_MANAGED_CELLS must be JSON/);
    });

    it('a production worker refuses the dev-only evidence signing secret, or one shorter than 32 characters', () => {
        const prod = { NODE_ENV: 'production', RUNTIME_RELEASE_VERSION: 'r1', RUNTIME_SECRET_SEAL_KEY: 'a1'.repeat(32), RUNTIME_EXECUTOR_ID: 'runtime-worker-0' };
        expect(() => loadWorkerConfig({ ...prod, RUNTIME_EVIDENCE_SIGNING_SECRET: 'dev-only-runtime-evidence-signing-secret-000000' })).toThrow(/RUNTIME_EVIDENCE_SIGNING_SECRET is the dev-only value/);
        expect(() => loadWorkerConfig({ ...prod, RUNTIME_EVIDENCE_SIGNING_SECRET: 'short' })).toThrow(/RUNTIME_EVIDENCE_SIGNING_SECRET must be at least 32 characters/);
        expect(loadWorkerConfig({ ...prod, RUNTIME_EVIDENCE_SIGNING_SECRET: 'e'.repeat(40) }).evidence.secret).toBe('e'.repeat(40));
        expect(loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX, RUNTIME_EVIDENCE_SIGNING_SECRET: 'short' }).evidence.secret).toBe('short');
    });

    it('a production worker refuses the dev-only seal key that is public in the repo', () => {
        const prod = { NODE_ENV: 'production', RUNTIME_RELEASE_VERSION: 'r1' };
        expect(() =>
            loadWorkerConfig({ ...prod, RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX }),
        ).toThrow(/dev-only seal key/);
        const ownKey = 'a1'.repeat(32);
        let error: unknown;
        try {
            loadWorkerConfig({ ...prod, RUNTIME_SECRET_SEAL_KEY: ownKey });
        } catch (e) {
            error = e;
        }
        expect(String(error ?? '')).not.toMatch(/seal key/i);
    });

    it('the worker does not start without a 32-byte seal key', () => {
        expect(() => loadWorkerConfig({})).toThrow(
            /RUNTIME_SECRET_SEAL_KEY is required/,
        );
        expect(() =>
            loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: 'abcd' }),
        ).toThrow(/RUNTIME_SECRET_SEAL_KEY/);
        const w = loadWorkerConfig({
            RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX,
            RUNTIME_GIT_PROVIDER: 'gitlab',
        });
        expect(w.secretSealKey).toHaveLength(32);
        expect(w.git.provider).toBe('gitlab');
        expect(() =>
            loadWorkerConfig({
                RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX,
                RUNTIME_GIT_PROVIDER: 'svn',
            }),
        ).toThrow();
    });

    it("caps an org's live claims on shared cells, 8 unless set, never 0", () => {
        expect(
            loadWorkerConfig({
                RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX,
            }).orgSharedClaimCap,
        ).toBe(8);
        expect(
            loadWorkerConfig({
                RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX,
                RUNTIME_ORG_SHARED_CLAIM_CAP: '3',
            }).orgSharedClaimCap,
        ).toBe(3);
        expect(() =>
            loadWorkerConfig({
                RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX,
                RUNTIME_ORG_SHARED_CLAIM_CAP: '0',
            }),
        ).toThrow(/RUNTIME_ORG_SHARED_CLAIM_CAP/);
    });
});

describe('RUNTIME_SETUP_AUTHOR_REPAIRS', () => {
    const repairs = (value?: string) => loadSetupConfig(value === undefined ? {} : { RUNTIME_SETUP_AUTHOR_REPAIRS: value }).authorRepairs;

    it('repairs a failed recipe of Kody twice in one setup when unset or empty', () => {
        expect(repairs()).toBe(2);
        expect(repairs('')).toBe(2);
    });

    it('reads a whitespace-only value as unset, not as 0 (repairs stay on)', () => {
        expect(repairs('  ')).toBe(2);
        expect(repairs('\t\n')).toBe(2);
    });

    it('reads a padded number as that number', () => {
        expect(repairs(' 1 ')).toBe(1);
    });

    it('turns repairs off with 0', () => {
        expect(repairs('0')).toBe(0);
    });

    it('takes any whole number up to 5', () => {
        expect(repairs('1')).toBe(1);
        expect(repairs('5')).toBe(5);
    });

    it.each(['6', '-1', '1.5', 'two', 'true'])('refuses %j, so the worker does not start', (value) => {
        expect(() => repairs(value)).toThrow('RUNTIME_SETUP_AUTHOR_REPAIRS');
    });

    it('is what the worker config carries to the setup service', () => {
        expect(loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX, RUNTIME_SETUP_AUTHOR_REPAIRS: '0' }).setup.authorRepairs).toBe(0);
        expect(loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX }).setup.authorRepairs).toBe(2);
    });
});

describe('tokens per Run', () => {
    it('defaults to the one shared limit on the worker side', () => {
        expect(loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX }).maxTokensPerRun).toBe(DEFAULT_MAX_TOKENS_PER_RUN);
        expect(loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX, RUNTIME_MAX_TOKENS_PER_RUN: '  ' }).maxTokensPerRun).toBe(DEFAULT_MAX_TOKENS_PER_RUN);
    });
});

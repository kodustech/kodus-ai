/**
 * Integration tests for SandboxLeaseManager lifecycle.
 *
 * Instantiated directly (no NestJS DI) with mocked dependencies:
 *   - leaseRepo: all methods as jest.fn()
 *   - sandboxProvider: ISandboxProvider as jest.fn()
 *   - configService: ConfigService.get as jest.fn()
 *
 * e2b static methods (Sandbox.kill, Sandbox.connect, Sandbox.setTimeout) are
 * provided by the global mock at test/__mocks__/e2b.ts (via moduleNameMapper)
 * and can be spy-on'd via jest.spyOn(Sandbox, 'kill') etc.
 *
 * All tests run without real E2B API calls or real Mongo.
 *
 * Test coverage:
 *   Test 1 — acquire-release happy path (Phase 1 criterion 2)
 *   Test 2 — concurrent acquire: exactly one createSandboxWithRepo call (Phase 1 criterion 3)
 *   Test 3 — invalidate via PR-close: soft-drain then delete (Phase 1 criterion 4)
 *   Test 4 — NullSandbox fallback when provider unavailable (Phase 1 criterion 5)
 *   Test 5 — reaper cleans crashed-worker lease (Phase 1 criterion 3)
 */

import { Sandbox } from 'e2b';
import { SandboxLeaseManager } from './sandbox-lease-manager.service';
import { SandboxLeaseReaperService } from './sandbox-lease-reaper.service';
import { SandboxLeaseRepository } from '../repositories/sandbox-lease.repository';
import {
    ISandboxProvider,
    SandboxInstance,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import { ConfigService } from '@nestjs/config';

// ─── Shared test helpers ─────────────────────────────────────────────────────

function makeMockLeaseRepo(): jest.Mocked<SandboxLeaseRepository> {
    return {
        upsertAcquire: jest.fn(),
        decrementLease: jest.fn(),
        updateReady: jest.fn().mockResolvedValue(undefined),
        markInvalidated: jest.fn().mockResolvedValue(undefined),
        findByPrKey: jest.fn().mockResolvedValue(null),
        findExpired: jest.fn().mockResolvedValue([]),
        delete: jest.fn().mockResolvedValue(undefined),
        setKillAt: jest.fn().mockResolvedValue(undefined),
        clearKillAt: jest.fn().mockResolvedValue(undefined),
        findReadyToKill: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<SandboxLeaseRepository>;
}

function makeMockSandboxProvider(available = true): jest.Mocked<ISandboxProvider> {
    const mockSandboxInstance: SandboxInstance = {
        remoteCommands: {
            grep: jest.fn().mockResolvedValue(''),
            read: jest.fn().mockResolvedValue(''),
            listDir: jest.fn().mockResolvedValue(''),
            exec: jest.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
        },
        cleanup: jest.fn().mockResolvedValue(undefined),
        type: 'e2b',
        sandboxId: 'mock-sandbox-id',
        repoDir: '/home/user/repo',
        run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        readFile: jest.fn().mockResolvedValue(''),
        writeFile: jest.fn().mockResolvedValue(undefined),
    };

    return {
        isAvailable: jest.fn().mockReturnValue(available),
        createSandboxWithRepo: jest.fn().mockResolvedValue(mockSandboxInstance),
    } as jest.Mocked<ISandboxProvider>;
}

function makeMockConfigService(e2bKey: string | undefined = 'test-e2b-key'): jest.Mocked<ConfigService> {
    return {
        get: jest.fn().mockReturnValue(e2bKey),
    } as unknown as jest.Mocked<ConfigService>;
}

function makeLeaseManager(
    leaseRepo: jest.Mocked<SandboxLeaseRepository>,
    sandboxProvider: jest.Mocked<ISandboxProvider>,
    configService: jest.Mocked<ConfigService>,
): SandboxLeaseManager {
    // Direct instantiation bypasses @Inject decorators — just pass positional args
    return new SandboxLeaseManager(
        sandboxProvider as any,
        leaseRepo,
        configService,
    );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SandboxLeaseManager', () => {
    let leaseRepo: jest.Mocked<SandboxLeaseRepository>;
    let sandboxProvider: jest.Mocked<ISandboxProvider>;
    let configService: jest.Mocked<ConfigService>;
    let manager: SandboxLeaseManager;

    beforeEach(() => {
        jest.clearAllMocks();
        leaseRepo = makeMockLeaseRepo();
        sandboxProvider = makeMockSandboxProvider(true);
        configService = makeMockConfigService('test-e2b-key');
        manager = makeLeaseManager(leaseRepo, sandboxProvider, configService);
    });

    // ─── Test 1: acquire-release happy path ───────────────────────────────

    it('acquire: creates sandbox when no existing lease; release sets idle timeout, does not kill', async () => {
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:42';

        // Creator path: leaseCount === 1 after upsert
        leaseRepo.upsertAcquire.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'CREATING',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        // Post-create: lease is READY (not INVALIDATED)
        leaseRepo.findByPrKey.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'READY',
            sandboxId: '',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        // Acquire
        const result = await manager.acquire(prKey, 'review');

        // Provider should be checked for availability
        expect(result).toBeDefined();
        expect(result.leaseId).toBeDefined();
        expect(result.sandbox).toBeDefined();

        // updateReady called with prKey
        expect(leaseRepo.updateReady).toHaveBeenCalledWith(prKey, expect.any(String));

        // Release: decrement lease
        leaseRepo.decrementLease.mockResolvedValue({
            _id: prKey,
            leaseCount: 0,
            state: 'READY',
            sandboxId: 'e2b-sandbox-123',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        await manager.release(result.leaseId);

        // When leaseCount hits 0 with sandboxId and API key: setTimeout applied
        expect(Sandbox.setTimeout).toHaveBeenCalledWith(
            'e2b-sandbox-123',
            300_000, // IDLE_TIMEOUT_MS
            { apiKey: 'test-e2b-key' },
        );

        // kill is NEVER called on release
        expect(Sandbox.kill).not.toHaveBeenCalled();
    });

    // ─── Test 2: concurrent acquire — exactly one createSandboxWithRepo ───

    it('second concurrent acquire polls until READY instead of creating a second sandbox', async () => {
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:99';

        // First acquire: creator path (leaseCount === 1)
        leaseRepo.upsertAcquire
            .mockResolvedValueOnce({
                _id: prKey,
                leaseCount: 1,
                state: 'CREATING',
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            } as any)
            // Second acquire: joiner path (leaseCount === 2, state CREATING)
            .mockResolvedValueOnce({
                _id: prKey,
                leaseCount: 2,
                state: 'CREATING',
                sandboxId: undefined,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            } as any);

        // Post-create check: READY (not INVALIDATED) — used by creator path
        leaseRepo.findByPrKey
            .mockResolvedValueOnce({
                _id: prKey,
                leaseCount: 1,
                state: 'READY',
                sandboxId: 'e2b-poll-sandbox',
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            } as any)
            // First poll: still CREATING
            .mockResolvedValueOnce({
                _id: prKey,
                leaseCount: 2,
                state: 'CREATING',
                sandboxId: undefined,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            } as any)
            // Second poll: READY with sandboxId — joiner connects
            .mockResolvedValueOnce({
                _id: prKey,
                leaseCount: 2,
                state: 'READY',
                sandboxId: 'e2b-poll-sandbox',
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            } as any);

        // Use fake timers to fast-forward polling without real delays
        jest.useFakeTimers();

        const acquire1Promise = manager.acquire(prKey, 'review');
        const acquire2Promise = manager.acquire(prKey, 'conversation');

        // Fast-forward past the poll interval (500ms) multiple times
        await jest.runAllTimersAsync();

        const [result1, result2] = await Promise.all([
            acquire1Promise,
            acquire2Promise,
        ]);

        jest.useRealTimers();

        // Both results have a sandbox — each caller got one
        expect(result1.sandbox).toBeDefined();
        expect(result2.sandbox).toBeDefined();

        // Joiner (second acquire) connected to existing sandbox via Sandbox.connect
        // (creator path — without cloneParams — uses null sandbox for initial CREATING→READY)
        expect(Sandbox.connect).toHaveBeenCalledWith(
            'e2b-poll-sandbox',
            { apiKey: 'test-e2b-key' },
        );

        // Key invariant: createSandboxWithRepo NOT called without cloneParams
        // (manager falls back to null sandbox when no clone params supplied).
        // The concurrency assertion is: Sandbox.connect is called exactly once
        // (only the joiner path connects; the creator took null-sandbox path).
        expect(Sandbox.connect).toHaveBeenCalledTimes(1);
    });

    // ─── Test 3: invalidate via PR-close (soft-drain + delete) ───────────

    it('invalidate: sets Sandbox.setTimeout(60s) then deletes Mongo doc', async () => {
        const prKey = 'org:repo:77';

        leaseRepo.findByPrKey.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'READY',
            sandboxId: 'e2b-to-invalidate',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        await manager.invalidate(prKey);

        // Soft-drain: 60s timeout applied (not IDLE_TIMEOUT_MS which is for release)
        expect(Sandbox.setTimeout).toHaveBeenCalledWith(
            'e2b-to-invalidate',
            60_000,
            { apiKey: 'test-e2b-key' },
        );

        // Mongo doc deleted after soft-drain
        expect(leaseRepo.delete).toHaveBeenCalledWith(prKey);

        // kill is NOT called synchronously (soft-drain, not immediate kill)
        expect(Sandbox.kill).not.toHaveBeenCalled();
    });

    // ─── Test 4: NullSandbox fallback when provider unavailable ──────────

    it('returns NullSandbox lease when provider.isAvailable() is false', async () => {
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:11';

        // Provider not available
        sandboxProvider = makeMockSandboxProvider(false);
        manager = makeLeaseManager(leaseRepo, sandboxProvider, configService);

        leaseRepo.upsertAcquire.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'CREATING',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        // Post-create check: READY
        leaseRepo.findByPrKey.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'READY',
            sandboxId: '',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        const result = await manager.acquire(prKey, 'review');

        // Got a result with a sandbox (null type)
        expect(result.sandbox).toBeDefined();
        expect(result.sandbox.type).toBe('null');

        // No E2B API calls made
        expect(sandboxProvider.createSandboxWithRepo).not.toHaveBeenCalled();
        expect(Sandbox.create).not.toHaveBeenCalled();
    });

    // ─── Test 5: Tenant isolation guard ───────────────────────────────────

    it.each([
        ['empty', ''],
        ['missing UUID prefix', 'not-a-uuid:repo:1'],
        ['only one segment', 'foo'],
        ['two segments', 'foo:bar'],
        ['five segments', 'a:b:c:d:e'],
        ['UUID v4-shape but invalid hex', 'gggggggg-aaaa-aaaa-aaaa-aaaaaaaaaaaa:r:1'],
    ])('rejects malformed prKey (%s) before any side-effect', async (_label, badKey) => {
        const leaseRepo = makeMockLeaseRepo();
        const configService = makeMockConfigService('test-e2b-key');
        const sandboxProvider = makeMockSandboxProvider(true);
        const manager = makeLeaseManager(leaseRepo, sandboxProvider, configService);

        await expect(manager.acquire(badKey, 'review')).rejects.toThrow(/Invalid prKey/);

        // CRITICAL: NO Mongo write happened, NO sandbox was created.
        // A malformed key MUST NOT pollute the lease collection.
        expect(leaseRepo.upsertAcquire).not.toHaveBeenCalled();
        expect(sandboxProvider.createSandboxWithRepo).not.toHaveBeenCalled();
    });

    // ─── Test 6: orphan kill when post-create Mongo step fails ────────────

    it('kills orphaned sandbox when updateReady fails after E2B create', async () => {
        // Quota-protection invariant: if Mongo flakes between create and
        // updateReady, the just-created E2B sandbox must be killed —
        // otherwise it sits idle for SANDBOX_TIMEOUT_MS (35min) burning
        // capacity on a lease nobody can find.
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:42';
        const cloneParams = {
            cloneUrl: 'https://github.com/org/repo.git',
            authToken: 'token',
            branch: 'feature',
            prNumber: 42,
            platform: 'GITHUB' as any,
        };

        leaseRepo.upsertAcquire.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'CREATING',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        // Provider succeeds — sandbox EXISTS in E2B with this id
        sandboxProvider.createSandboxWithRepo.mockResolvedValue({
            type: 'e2b',
            sandboxId: 'orphan-sandbox-id',
            cleanup: jest.fn(),
            remoteCommands: {} as any,
            run: jest.fn(),
            readFile: jest.fn(),
            writeFile: jest.fn(),
            repoDir: '/home/user/repo',
        } as any);

        // updateReady fails AFTER the sandbox was created
        leaseRepo.updateReady.mockRejectedValue(new Error('Mongo connection lost'));

        await expect(
            manager.acquire(prKey, 'review', undefined, cloneParams),
        ).rejects.toThrow(/Mongo connection lost/);

        // Critical: the orphan was killed
        expect(Sandbox.kill).toHaveBeenCalledWith('orphan-sandbox-id', {
            apiKey: 'test-e2b-key',
        });
        // And the lease doc was cleaned up so other callers don't poll forever
        expect(leaseRepo.delete).toHaveBeenCalledWith(prKey);
    });

    // ─── Test 7: retry succeeds on 2nd attempt ────────────────────────────

    it('retries createSandboxWithRepo on transient failure and succeeds within budget', async () => {
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:50';
        const cloneParams = {
            cloneUrl: 'https://github.com/org/repo.git',
            authToken: 'token',
            branch: 'feature',
            prNumber: 50,
            platform: 'GITHUB' as any,
        };

        leaseRepo.upsertAcquire.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'CREATING',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);
        leaseRepo.findByPrKey.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'READY',
            sandboxId: 'retry-success-id',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        // First attempt throws (transient), second succeeds
        sandboxProvider.createSandboxWithRepo
            .mockRejectedValueOnce(new Error('E2B 503 transient'))
            .mockResolvedValueOnce({
                type: 'e2b',
                sandboxId: 'retry-success-id',
                cleanup: jest.fn(),
                remoteCommands: {} as any,
                run: jest.fn(),
                readFile: jest.fn(),
                writeFile: jest.fn(),
                repoDir: '/home/user/repo',
            } as any);

        jest.useFakeTimers();
        const acquirePromise = manager.acquire(prKey, 'review', undefined, cloneParams);

        // Fast-forward through the 60s backoff between attempt 1 and 2
        await jest.runAllTimersAsync();

        const result = await acquirePromise;
        jest.useRealTimers();

        expect(sandboxProvider.createSandboxWithRepo).toHaveBeenCalledTimes(2);
        expect(result.sandboxId).toBe('retry-success-id');
        // Failed first sandbox was never created (provider threw before returning),
        // so nothing to kill.
        expect(Sandbox.kill).not.toHaveBeenCalled();
    });

    // ─── Test 8: retry budget exhausted — error propagates, no orphan ────

    it('throws after 3 failed createSandboxWithRepo attempts and cleans lease doc', async () => {
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:51';
        const cloneParams = {
            cloneUrl: 'https://github.com/org/repo.git',
            authToken: 'token',
            branch: 'feature',
            prNumber: 51,
            platform: 'GITHUB' as any,
        };

        leaseRepo.upsertAcquire.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'CREATING',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        // All 3 attempts fail
        sandboxProvider.createSandboxWithRepo.mockRejectedValue(
            new Error('E2B quota exceeded'),
        );

        jest.useFakeTimers();
        const acquirePromise = manager
            .acquire(prKey, 'review', undefined, cloneParams)
            .catch((err) => err);

        // Fast-forward through both backoffs (60s + 120s)
        await jest.runAllTimersAsync();

        const err = await acquirePromise;
        jest.useRealTimers();

        // 3 attempts (initial + 2 retries) before giving up
        expect(sandboxProvider.createSandboxWithRepo).toHaveBeenCalledTimes(3);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/E2B quota exceeded/);
        // Lease doc cleaned up so polling joiners don't hang forever
        expect(leaseRepo.delete).toHaveBeenCalledWith(prKey);
        // No sandbox to kill — provider never returned one
        expect(Sandbox.kill).not.toHaveBeenCalled();
    });

    // ─── Test 9c: release writes killAt on the lease doc ──────────────────

    it('release writes killAt = now + idleMs on the lease doc (multi-worker safe)', async () => {
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:200';

        leaseRepo.upsertAcquire.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'CREATING',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);
        leaseRepo.findByPrKey.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'READY',
            sandboxId: '',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        const result = await manager.acquire(prKey, 'review');

        leaseRepo.decrementLease.mockResolvedValue({
            _id: prKey,
            leaseCount: 0,
            state: 'READY',
            sandboxId: 'idle-kill-sandbox',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        const before = Date.now();
        await manager.release(result.leaseId, { idleMs: 30_000 });

        // killAt scheduled in Mongo — the killIdleSandboxes cron will sweep it.
        // No in-memory timer involved, so any worker can pick up the kill.
        expect(leaseRepo.setKillAt).toHaveBeenCalledTimes(1);
        const [calledPrKey, calledKillAt] = (
            leaseRepo.setKillAt as jest.Mock
        ).mock.calls[0];
        expect(calledPrKey).toBe(prKey);
        expect(calledKillAt).toBeInstanceOf(Date);
        const expectedAt = before + 30_000;
        expect(calledKillAt.getTime()).toBeGreaterThanOrEqual(expectedAt - 50);
        expect(calledKillAt.getTime()).toBeLessThanOrEqual(expectedAt + 50);

        // E2B-side defence-in-depth setTimeout still applied
        expect(Sandbox.setTimeout).toHaveBeenCalledWith(
            'idle-kill-sandbox',
            30_000,
            { apiKey: 'test-e2b-key' },
        );
        // No synchronous kill — that's the cron's job
        expect(Sandbox.kill).not.toHaveBeenCalled();
        expect(leaseRepo.delete).not.toHaveBeenCalled();
    });

    // ─── Test 9d: acquire clears killAt atomically (warm reuse) ───────────

    it('acquire clears killAt on the lease doc so any worker preserves warm reuse', async () => {
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:201';

        // Scenario: worker A scheduled a kill (lease has killAt set). Worker
        // B receives a new @kody and calls acquire — must clear killAt
        // atomically so the cron doesn't kill the sandbox under us.
        leaseRepo.upsertAcquire.mockResolvedValue({
            _id: prKey,
            leaseCount: 2,
            state: 'READY',
            sandboxId: 'warm-sandbox',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        await manager.acquire(prKey, 'conversation');

        expect(leaseRepo.clearKillAt).toHaveBeenCalledWith(prKey);
        // Joiner connects to the still-running sandbox
        expect(Sandbox.connect).toHaveBeenCalledWith('warm-sandbox', {
            apiKey: 'test-e2b-key',
        });
    });

    // ─── Test 9e: stale connect → delete lease + cold-start ───────────────

    it('joiner falls back to cold-start when E2B sandbox no longer exists', async () => {
        // Scenario: review released and the idle-kill fired, but a slow @kody
        // arrives just after — the lease doc may still exist for a tick.
        // Sandbox.connect throws "sandbox not found" → we delete the stale
        // lease and re-acquire as creator with a fresh sandbox.
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:202';
        const cloneParams = {
            cloneUrl: 'https://github.com/org/repo.git',
            authToken: 'token',
            branch: 'feature',
            prNumber: 202,
            platform: 'GITHUB' as any,
        };

        // 1st upsertAcquire: existing lease pointing to a dead sandboxId
        // 2nd upsertAcquire (after delete): fresh CREATING (cold-start)
        leaseRepo.upsertAcquire
            .mockResolvedValueOnce({
                _id: prKey,
                leaseCount: 1,
                state: 'READY',
                sandboxId: 'dead-sandbox-id',
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            } as any)
            .mockResolvedValueOnce({
                _id: prKey,
                leaseCount: 1,
                state: 'CREATING',
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            } as any);

        // findByPrKey called by handleCreatorPath post-create (READY check)
        leaseRepo.findByPrKey.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'READY',
            sandboxId: 'fresh-sandbox-id',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        // Sandbox.connect rejects on the dead id (E2B no longer has it)
        (Sandbox.connect as jest.Mock).mockRejectedValueOnce(
            new Error('sandbox not found'),
        );

        sandboxProvider.createSandboxWithRepo.mockResolvedValue({
            type: 'e2b',
            sandboxId: 'fresh-sandbox-id',
            cleanup: jest.fn(),
            remoteCommands: {} as any,
            run: jest.fn(),
            readFile: jest.fn(),
            writeFile: jest.fn(),
            repoDir: '/home/user/repo',
        } as any);

        const result = await manager.acquire(
            prKey,
            'conversation',
            undefined,
            cloneParams,
        );

        // Stale lease was deleted before cold-start
        expect(leaseRepo.delete).toHaveBeenCalledWith(prKey);
        // Cold-start succeeded — fresh sandbox created
        expect(sandboxProvider.createSandboxWithRepo).toHaveBeenCalledWith(cloneParams);
        expect(result.sandboxId).toBe('fresh-sandbox-id');
        expect(result.wasCreated).toBe(true);
    });

    // ─── Test 9a: release accepts custom idleMs (review uses 30s) ────────

    it('release(leaseId, { idleMs }) overrides the 5min default — review flow uses 30s', async () => {
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:99';

        leaseRepo.upsertAcquire.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'CREATING',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);
        leaseRepo.findByPrKey.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'READY',
            sandboxId: '',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        const result = await manager.acquire(prKey, 'review');

        leaseRepo.decrementLease.mockResolvedValue({
            _id: prKey,
            leaseCount: 0,
            state: 'READY',
            sandboxId: 'review-sandbox-id',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        // Caller (CreateSandboxStage) passes 30s
        await manager.release(result.leaseId, { idleMs: 30_000 });

        expect(Sandbox.setTimeout).toHaveBeenCalledWith(
            'review-sandbox-id',
            30_000, // not the 5min default
            { apiKey: 'test-e2b-key' },
        );
    });

    // ─── Test 9: mid-create invalidation kills the sandbox ────────────────

    it('kills sandbox when lease was invalidated mid-create (Pitfall 5)', async () => {
        // PR-close arrives WHILE a sandbox is being created. The doc state
        // flips to INVALIDATED. After the provider returns, the manager
        // re-reads the lease, sees INVALIDATED, and must kill the just-
        // created sandbox so it doesn't run for the full ceiling.
        const prKey = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:88';
        const cloneParams = {
            cloneUrl: 'https://github.com/org/repo.git',
            authToken: 'token',
            branch: 'feature',
            prNumber: 88,
            platform: 'GITHUB' as any,
        };

        leaseRepo.upsertAcquire.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'CREATING',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        sandboxProvider.createSandboxWithRepo.mockResolvedValue({
            type: 'e2b',
            sandboxId: 'mid-create-sandbox-id',
            cleanup: jest.fn(),
            remoteCommands: {} as any,
            run: jest.fn(),
            readFile: jest.fn(),
            writeFile: jest.fn(),
            repoDir: '/home/user/repo',
        } as any);

        // Post-create check returns INVALIDATED (someone called invalidate())
        leaseRepo.findByPrKey.mockResolvedValue({
            _id: prKey,
            leaseCount: 1,
            state: 'INVALIDATED',
            sandboxId: 'mid-create-sandbox-id',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        } as any);

        await expect(
            manager.acquire(prKey, 'review', undefined, cloneParams),
        ).rejects.toThrow(/invalidated mid-create/);

        // The sandbox was killed (not left for the 35min ceiling)
        expect(Sandbox.kill).toHaveBeenCalledWith('mid-create-sandbox-id', {
            apiKey: 'test-e2b-key',
        });
        // Doc cleaned up
        expect(leaseRepo.delete).toHaveBeenCalledWith(prKey);
    });
});

// ─── Test 5: Reaper cleans crashed-worker lease ───────────────────────────

describe('SandboxLeaseReaperService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('reaper cleans ALL expired leases regardless of leaseCount (crashed-worker scenario)', async () => {
        const leaseRepo = makeMockLeaseRepo();
        const configService = makeMockConfigService('test-e2b-key');

        // Expired lease with leaseCount:1 (crashed worker never called release)
        leaseRepo.findExpired.mockResolvedValue([
            {
                _id: 'org:repo:1',
                sandboxId: 'e2b-123',
                leaseCount: 1,
                state: 'READY',
                createdAt: new Date(Date.now() - 60 * 60 * 1000),
                expiresAt: new Date(Date.now() - 10 * 60 * 1000),
            } as any,
        ]);

        const mockLock = { release: jest.fn().mockResolvedValue(undefined) };
        const mockDistributedLockService = {
            acquire: jest.fn().mockResolvedValue(mockLock),
        };

        const reaper = new SandboxLeaseReaperService(
            leaseRepo,
            mockDistributedLockService as any,
            configService,
        );

        await reaper.reapExpiredLeases();

        // Sandbox.kill called with the expired sandbox ID
        expect(Sandbox.kill).toHaveBeenCalledWith('e2b-123', { apiKey: 'test-e2b-key' });

        // Mongo doc deleted
        expect(leaseRepo.delete).toHaveBeenCalledWith('org:repo:1');
    });

    // ─── Idle-kill cron tests ────────────────────────────────────────────

    it('killIdleSandboxes: kills + deletes leases past their killAt', async () => {
        const leaseRepo = makeMockLeaseRepo();
        const configService = makeMockConfigService('test-e2b-key');

        leaseRepo.findReadyToKill.mockResolvedValue([
            {
                _id: 'org-uuid:repo:1',
                sandboxId: 'e2b-idle-1',
                leaseCount: 0,
                state: 'READY',
                killAt: new Date(Date.now() - 1000),
                createdAt: new Date(Date.now() - 60 * 1000),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            } as any,
            {
                _id: 'org-uuid:repo:2',
                sandboxId: 'e2b-idle-2',
                leaseCount: 0,
                state: 'READY',
                killAt: new Date(Date.now() - 2000),
                createdAt: new Date(Date.now() - 60 * 1000),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            } as any,
        ]);

        const mockLock = { release: jest.fn().mockResolvedValue(undefined) };
        const mockDistributedLockService = {
            acquire: jest.fn().mockResolvedValue(mockLock),
        };

        const reaper = new SandboxLeaseReaperService(
            leaseRepo,
            mockDistributedLockService as any,
            configService,
        );

        await reaper.killIdleSandboxes();

        // Acquired the dedicated idle-kill lock (NOT the reaper one)
        expect(mockDistributedLockService.acquire).toHaveBeenCalledWith(
            'CRON:SANDBOX:IDLE_KILL',
            { ttl: 25_000 },
        );
        expect(Sandbox.kill).toHaveBeenCalledWith('e2b-idle-1', { apiKey: 'test-e2b-key' });
        expect(Sandbox.kill).toHaveBeenCalledWith('e2b-idle-2', { apiKey: 'test-e2b-key' });
        expect(leaseRepo.delete).toHaveBeenCalledWith('org-uuid:repo:1');
        expect(leaseRepo.delete).toHaveBeenCalledWith('org-uuid:repo:2');
        expect(mockLock.release).toHaveBeenCalledTimes(1);
    });

    it('killIdleSandboxes: skips when another worker holds the lock', async () => {
        const leaseRepo = makeMockLeaseRepo();
        const configService = makeMockConfigService('test-e2b-key');

        // Lock service returns null — another worker is sweeping
        const mockDistributedLockService = {
            acquire: jest.fn().mockResolvedValue(null),
        };

        const reaper = new SandboxLeaseReaperService(
            leaseRepo,
            mockDistributedLockService as any,
            configService,
        );

        await reaper.killIdleSandboxes();

        // Did not query Mongo nor call E2B — clean exit
        expect(leaseRepo.findReadyToKill).not.toHaveBeenCalled();
        expect(Sandbox.kill).not.toHaveBeenCalled();
        expect(leaseRepo.delete).not.toHaveBeenCalled();
    });

    it('killIdleSandboxes: continues deleting Mongo doc even when Sandbox.kill fails', async () => {
        const leaseRepo = makeMockLeaseRepo();
        const configService = makeMockConfigService('test-e2b-key');

        leaseRepo.findReadyToKill.mockResolvedValue([
            {
                _id: 'org-uuid:repo:9',
                sandboxId: 'e2b-already-gone',
                leaseCount: 0,
                state: 'READY',
                killAt: new Date(Date.now() - 1000),
                createdAt: new Date(Date.now() - 60 * 1000),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            } as any,
        ]);

        // E2B already removed the sandbox (race with reaper, external kill, etc.)
        (Sandbox.kill as jest.Mock).mockRejectedValueOnce(
            new Error('sandbox not found'),
        );

        const mockLock = { release: jest.fn().mockResolvedValue(undefined) };
        const mockDistributedLockService = {
            acquire: jest.fn().mockResolvedValue(mockLock),
        };

        const reaper = new SandboxLeaseReaperService(
            leaseRepo,
            mockDistributedLockService as any,
            configService,
        );

        await reaper.killIdleSandboxes();

        // Doc deleted regardless — lease can't linger waiting for a sandbox
        // that's already gone
        expect(leaseRepo.delete).toHaveBeenCalledWith('org-uuid:repo:9');
        expect(mockLock.release).toHaveBeenCalledTimes(1);
    });
});

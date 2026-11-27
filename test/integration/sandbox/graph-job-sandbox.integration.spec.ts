jest.unmock('@libs/core/log/logger');

import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { Sandbox } from 'e2b';
import { Connection, createConnection } from 'mongoose';
import pino from 'pino';
import { AstGraphBuildJobProcessor } from '@libs/code-review/workflow/ast-graph-build-job.processor';
import { AstGraphIncrementalJobProcessor } from '@libs/code-review/workflow/ast-graph-incremental-job.processor';
import { addLogProcessor, removeLogProcessor } from '@libs/core/log/logger';
import { MongoDBExporter } from '@libs/core/observability/exporters/mongodb-exporter';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { SandboxWaitAbortedError } from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import { SandboxLeaseRepository } from '@libs/sandbox/infrastructure/repositories/sandbox-lease.repository';
import {
    SandboxLeaseModel,
    SandboxLeaseSchema,
} from '@libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model';
import { SandboxLeaseManager } from '@libs/sandbox/infrastructure/services/sandbox-lease-manager.service';
import { resolveMongoTestGate } from '../mongo-test-uri';

const { shouldSkip, mongoUri } = resolveMongoTestGate('kodus_test_graph_job');
const organizationId = randomUUID();
const repositoryId = randomUUID();

(shouldSkip ? describe.skip : describe)('graph job leases in Mongo', () => {
    let connection: Connection;
    let leases: SandboxLeaseRepository;
    let manager: SandboxLeaseManager;
    const sandbox = {
        sandboxId: 'graph-sandbox',
        type: 'e2b',
        repoDir: '/repo',
        remoteCommands: {},
        run: jest.fn().mockResolvedValue({ stdout: 'abc123' }),
        cleanup: jest.fn(),
    };
    const provider = {
        isAvailable: () => true,
        createSandboxWithRepo: jest.fn(),
    };
    const indexer = { fullBuild: jest.fn(), incrementalUpdate: jest.fn() };
    const repo = {
        findById: async () => ({
            externalId: 'repo',
            fullName: 'org/repo',
            defaultBranch: 'main',
        }),
        updateGraphStatus: jest.fn(),
    };
    const code = {
        getCloneParams: async () => ({ url: 'https://example.org/repo.git' }),
    };
    const jobs = {
        findOne: async () => ({
            payload: {
                repositoryId,
                fullName: 'org/repo',
                defaultBranch: 'main',
                platform: 'GITHUB',
                changedFiles: ['src/file.ts'],
                newSha: 'abc123',
                organizationAndTeamData: { organizationId },
            },
        }),
        update: jest.fn(),
    };

    beforeAll(async () => {
        // Exercise the Mongo log processor without opening a stdout worker.
        jest.spyOn(pino, 'transport').mockReturnValue(
            new PassThrough().resume() as never,
        );
        connection = await createConnection(mongoUri).asPromise();
        leases = new SandboxLeaseRepository(
            connection.model(SandboxLeaseModel.name, SandboxLeaseSchema),
        );
    });
    beforeEach(() => {
        jest.clearAllMocks();
        provider.createSandboxWithRepo.mockResolvedValue(sandbox);
        manager = new SandboxLeaseManager(
            provider as never,
            leases,
            new ConfigService({ API_E2B_KEY: 'test-key' }),
        );
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        await connection
            .collection('sandbox_leases')
            .deleteMany({ organizationId });
    });
    afterAll(async () => {
        await connection?.close();
    });

    function graphJob(
        Processor:
            | typeof AstGraphBuildJobProcessor
            | typeof AstGraphIncrementalJobProcessor,
    ) {
        const jobId = randomUUID();
        const processor = new Processor(
            jobs as never,
            manager,
            code as never,
            indexer as never,
            repo as never,
        );
        return {
            prKey: `${organizationId}:${repositoryId}:graph:${jobId}`,
            run: (signal?: AbortSignal) => processor.process(jobId, signal),
        };
    }

    it('an aborted same-job retry leaves cleanup without acquiring the next sandbox', async () => {
        const { prKey, run } = graphJob(AstGraphIncrementalJobProcessor);
        await leases.upsertAcquire(prKey, 60_000);
        await leases.updateReady(prKey, 'previous-sandbox');
        await leases.decrementLease(prKey);
        await leases.claimCleanup(prKey, 'previous-sandbox', true, new Date());
        const decrement = leases.decrementLease.bind(leases);
        const waiting = new Promise<void>((resolve) => {
            jest.spyOn(leases, 'decrementLease').mockImplementationOnce(
                async (key) => {
                    const doc = await decrement(key);
                    resolve();
                    return doc;
                },
            );
        });
        const acquiring = jest.spyOn(manager, 'acquire');
        const controller = new AbortController();
        const job = run(controller.signal);
        await waiting;
        const abandoned = acquiring.mock.results[0].value;
        controller.abort();
        await job;
        await leases.completeCleanup(prKey, 'previous-sandbox');
        await expect(abandoned).rejects.toBeInstanceOf(SandboxWaitAbortedError);
        expect(provider.createSandboxWithRepo).not.toHaveBeenCalled();
        await run();
        expect(provider.createSandboxWithRepo).toHaveBeenCalledTimes(1);
        expect(Sandbox.kill).toHaveBeenCalledTimes(1);
        expect(await leases.findByPrKey(prKey)).toBeNull();
    });

    it.each([AstGraphBuildJobProcessor, AstGraphIncrementalJobProcessor])(
        '%p releases exactly once when creation finishes after cancellation',
        async (Processor) => {
            const { prKey, run } = graphJob(Processor);
            let finishCreate: () => void;
            const creating = new Promise<void>((started) => {
                provider.createSandboxWithRepo.mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            finishCreate = () => resolve(sandbox);
                            started();
                        }),
                );
            });
            const acquire = jest.spyOn(manager, 'acquire');
            const release = jest.spyOn(manager, 'release');
            const controller = new AbortController();
            const job = run(controller.signal);
            await creating;
            controller.abort();
            await job;
            expect(jobs.update.mock.calls.at(-1)[1].status).toBe(
                JobStatus.FAILED,
            );
            expect(release).not.toHaveBeenCalled();
            finishCreate();
            const lease = await acquire.mock.results[0].value;
            await new Promise<void>((resolve) => setImmediate(resolve));
            await release.mock.results[0]?.value;
            expect(await leases.findByPrKey(prKey)).toBeNull();
            expect(release.mock.calls).toEqual([
                [lease.leaseId, { idleMs: 0 }],
            ]);
            expect(Sandbox.kill).toHaveBeenCalledTimes(1);
            expect(indexer.fullBuild).not.toHaveBeenCalled();
            expect(indexer.incrementalUpdate).not.toHaveBeenCalled();
        },
    );

    it('finds release outcomes by organization with the lease key and sandbox ID', async () => {
        const collection = 'graph_logs_' + randomUUID().replace(/-/g, '');
        const logs = await connection.db.createCollection(collection, {
            timeseries: { timeField: 'timestamp', metaField: 'metadata' },
        });
        jest.replaceProperty(process, 'env', {
            ...process.env,
            API_LOG_LEVEL: 'info',
        });
        const exporter = new MongoDBExporter({
            bucketKeys: ['organizationId'],
            batchSize: 500,
        });
        // Share the suite's connection so only this collection receives its logs.
        Object.assign(exporter, { collections: { logs } });
        try {
            addLogProcessor(exporter);
            const succeeded = graphJob(AstGraphBuildJobProcessor);
            await succeeded.run();
            const failed = graphJob(AstGraphIncrementalJobProcessor);
            (Sandbox.kill as jest.Mock).mockRejectedValueOnce(
                new Error('provider unavailable'),
            );
            await failed.run();
            const unclaimed = graphJob(AstGraphBuildJobProcessor);
            jest.spyOn(leases, 'claimCleanup').mockResolvedValueOnce(null);
            await unclaimed.run();

            await exporter.flush();
            for (const [prKey, message] of [
                [succeeded.prKey, /killed single-use sandbox immediately/],
                [failed.prKey, /immediate kill failed/],
                [unclaimed.prKey, /single-use release lost the cleanup claim/],
            ] as const) {
                expect(
                    await logs.findOne({
                        'metadata.organizationId': organizationId,
                        'attributes.prKey': prKey,
                        'attributes.sandboxId': sandbox.sandboxId,
                        message,
                    }),
                ).not.toBeNull();
            }
            expect(
                await logs.countDocuments({
                    'metadata.organizationId': organizationId,
                    'message': /Sandbox cleaned up for org\/repo/,
                    'attributes.sandboxId': sandbox.sandboxId,
                }),
            ).toBe(3);
        } finally {
            removeLogProcessor(exporter);
            await logs.drop();
        }
    });
});

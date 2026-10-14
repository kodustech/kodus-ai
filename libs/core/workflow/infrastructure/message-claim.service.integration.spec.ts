/**
 * INTEGRATION TEST — MessageClaimService over InboxMessageRepository against
 * a real Postgres (the claim / complete / release / shutdown-release SQL).
 * Skips automatically if Postgres isn't reachable, like
 * distributed-lock.service.integration.spec.ts.
 */
require('dotenv').config();

import { hostname } from 'node:os';

import { DataSource } from 'typeorm';

import { MessageClaimService } from './message-claim.service';
import { InboxMessageRepository } from './repositories/inbox-message.repository';
import { InboxMessageModel } from './repositories/schemas/inbox-message.model';
import { OutboxMessageModel } from './repositories/schemas/outbox-message.model';
import { WorkflowJobModel } from './repositories/schemas/workflow-job.model';

const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.TEST_PG_HOST ?? 'localhost',
    port: parseInt(
        process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
        10,
    ),
    username:
        process.env.TEST_PG_USER ?? process.env.API_PG_DB_USERNAME ?? 'kodusdev',
    password:
        process.env.TEST_PG_PASSWORD ??
        process.env.API_PG_DB_PASSWORD ??
        'kodusdev',
    database:
        process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db',
    logging: false,
    synchronize: false,
    entities: [InboxMessageModel, OutboxMessageModel, WorkflowJobModel],
});

/** Postgres not running or not reachable: skip. Anything else must fail. */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

(skipIntegration ? describe.skip : describe)(
    'MessageClaimService (integration, real Postgres)',
    () => {
        let canRun = true;
        let repository: InboxMessageRepository;
        let service: MessageClaimService;
        const consumer = `claim-it-${process.pid}-${Date.now()}`;

        const row = (key: string) =>
            dataSource
                .getRepository(InboxMessageModel)
                .findOneBy({ consumerId: consumer, messageId: key });

        beforeAll(async () => {
            try {
                await dataSource.initialize();
            } catch (error) {
                // A bad entity list or query would otherwise skip every test
                // and still report green.
                if (!UNREACHABLE.has((error as { code?: string })?.code)) {
                    throw error;
                }
                canRun = false;
                return;
            }
            repository = new InboxMessageRepository(
                dataSource.getRepository(InboxMessageModel),
            );
            service = new MessageClaimService(repository);
        });

        afterAll(async () => {
            if (dataSource.isInitialized) {
                await dataSource.query(
                    'DELETE FROM kodus_workflow.inbox_messages WHERE "consumerId" = $1',
                    [consumer],
                );
                await dataSource.destroy();
            }
        });

        it('lets exactly one of several concurrent claims win', async () => {
            if (!canRun) return;
            const holders = await Promise.all(
                [1, 2, 3, 4].map(() => service.claim(consumer, 'concurrent')),
            );

            expect(holders.filter(Boolean)).toHaveLength(1);
        });

        it('refuses a key once it is completed, and complete needs the holder', async () => {
            if (!canRun) return;
            const holder = await service.claim(consumer, 'complete');

            await service.complete(consumer, 'complete', 'someone-else');
            expect((await row('complete')).status).toBe('PROCESSING');

            await service.complete(consumer, 'complete', holder);
            expect((await row('complete')).status).toBe('PROCESSED');
            await expect(service.claim(consumer, 'complete')).resolves.toBeNull();
        });

        it('lets a key be claimed again after its holder releases it, but not after a stranger does', async () => {
            if (!canRun) return;
            const holder = await service.claim(consumer, 'release');

            await service.release(consumer, 'release', 'someone-else');
            await expect(service.claim(consumer, 'release')).resolves.toBeNull();

            await service.release(consumer, 'release', holder);
            await expect(
                service.claim(consumer, 'release'),
            ).resolves.toEqual(expect.any(String));
        });

        it('never reopens a completed key on release', async () => {
            if (!canRun) return;
            const holder = await service.claim(consumer, 'done');
            await service.complete(consumer, 'done', holder);

            await service.release(consumer, 'done', holder);

            expect((await row('done')).status).toBe('PROCESSED');
        });

        it('releases per-attempt claims of this instance on shutdown, and only those', async () => {
            if (!canRun) return;
            await service.claim(consumer, 'shutdown');
            await dataSource.query(
                `INSERT INTO kodus_workflow.inbox_messages
                    ("messageId", "consumerId", status, "lockedBy", "lockedAt", attempts, "createdAt", "updatedAt")
                 VALUES ($1, $2, 'PROCESSING', $3, NOW(), 1, NOW(), NOW())`,
                ['other-instance', consumer, `${hostname()}x:attempt`],
            );

            await repository.releaseAllByInstance(hostname());

            expect((await row('shutdown')).status).toBe('READY');
            // A different instance whose name merely starts the same is kept.
            expect((await row('other-instance')).status).toBe('PROCESSING');
        });
    },
);

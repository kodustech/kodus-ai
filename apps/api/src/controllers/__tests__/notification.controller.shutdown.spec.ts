import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { GetKodyRulesIndexUseCase } from '@libs/kodyRules/application/use-cases/get-kody-rules-index.use-case';
import { NotificationQueryService } from '@libs/notifications/application/notification-query.service';
import { NotificationSseService } from '@libs/notifications/application/notification-sse.service';
import { RoutingRuleService } from '@libs/notifications/application/routing-rule.service';

import { NotificationController } from '../notification.controller';

/**
 * The API must stop on SIGTERM while a browser keeps the notification stream
 * open. Nest closes the HTTP server on shutdown, and a server waits for every
 * open response: the stream has to be ended by the API itself.
 */
describe('NotificationController stream on shutdown', () => {
    let app: INestApplication;
    let request: http.ClientRequest | undefined;

    beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
            controllers: [NotificationController],
            providers: [
                NotificationSseService,
                {
                    provide: NotificationQueryService,
                    useValue: { unreadCount: jest.fn().mockResolvedValue(3) },
                },
                { provide: RoutingRuleService, useValue: {} },
                { provide: GetKodyRulesIndexUseCase, useValue: {} },
            ],
        })
            .overrideGuard(PolicyGuard)
            .useValue({ canActivate: () => true })
            .compile();

        app = moduleRef.createNestApplication();
        app.use((req: any, _res: unknown, next: () => void) => {
            req.user = { uuid: 'user-1', organization: { uuid: 'org-1' } };
            next();
        });
        await app.listen(0, '127.0.0.1');
    });

    afterEach(async () => {
        // Lets a server still waiting for the stream finish closing.
        request?.destroy();
        await app.close();
    });

    /** Opens the stream and resolves once its first event arrived. */
    const openStream = () =>
        new Promise<{ ended: Promise<void> }>((resolve, reject) => {
            const { port } = app.getHttpServer().address() as AddressInfo;
            request = http.get(
                { host: '127.0.0.1', port, path: '/notifications/stream' },
                (response) => {
                    const ended = new Promise<void>((done) => {
                        response.on('end', done);
                        response.on('close', done);
                    });
                    response.once('data', () => resolve({ ended }));
                },
            );
            request.on('error', reject);
        });

    const within = <T>(promise: Promise<T>, ms: number) => {
        let timer: NodeJS.Timeout;
        return Promise.race([
            promise.then(() => 'done' as const),
            new Promise<'timed out'>((resolve) => {
                timer = setTimeout(() => resolve('timed out'), ms);
            }),
        ]).finally(() => clearTimeout(timer));
    };

    it('closes the API while a client keeps the stream open', async () => {
        const stream = await openStream();

        await expect(within(app.close(), 2_000)).resolves.toBe('done');
        await expect(within(stream.ended, 2_000)).resolves.toBe('done');
    });
});

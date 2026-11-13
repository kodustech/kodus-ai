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

describe('NotificationController stream', () => {
    let app: INestApplication;
    let request: http.ClientRequest | undefined;
    let unreadCount: jest.Mock;

    beforeEach(async () => {
        unreadCount = jest.fn().mockResolvedValue(3);
        const moduleRef = await Test.createTestingModule({
            controllers: [NotificationController],
            providers: [
                NotificationSseService,
                {
                    provide: NotificationQueryService,
                    useValue: { unreadCount },
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

    // The API must stop on SIGTERM while a browser keeps the stream open.
    // Nest closes the HTTP server on shutdown, and a server waits for every
    // open response: the stream has to be ended by the API itself.
    it('closes the API while a client keeps the stream open', async () => {
        const stream = await openStream();

        await expect(within(app.close(), 2_000)).resolves.toBe('done');
        await expect(within(stream.ended, 2_000)).resolves.toBe('done');
    });

    // A shutdown can start while a stream still waits for its first event.
    it('closes the API while a stream is still reading its unread count', async () => {
        let answer: (count: number) => void = () => undefined;
        unreadCount.mockReturnValue(
            new Promise<number>((resolve) => {
                answer = resolve;
            }),
        );
        const hook = jest.spyOn(
            app.get(NotificationSseService),
            'beforeApplicationShutdown',
        );

        // The headers are sent before the unread count is read.
        const { ended } = await new Promise<{ ended: Promise<void> }>(
            (resolve, reject) => {
                const { port } = app.getHttpServer().address() as AddressInfo;
                request = http.get(
                    { host: '127.0.0.1', port, path: '/notifications/stream' },
                    (response) => {
                        response.resume();
                        resolve({
                            ended: new Promise<void>((done) => {
                                response.on('end', done);
                                response.on('close', done);
                            }),
                        });
                    },
                );
                request.on('error', reject);
            },
        );
        const closing = app.close();
        await within(
            new Promise<void>((done) => {
                const poll = setInterval(() => {
                    if (hook.mock.calls.length) {
                        clearInterval(poll);
                        done();
                    }
                }, 5);
            }),
            2_000,
        );
        answer(3);

        await expect(within(closing, 2_000)).resolves.toBe('done');
        await expect(within(ended, 2_000)).resolves.toBe('done');
    });

    it('keeps nothing of a client that left before its stream was ready', async () => {
        let answer: (count: number) => void = () => undefined;
        unreadCount.mockReturnValue(
            new Promise<number>((resolve) => {
                answer = resolve;
            }),
        );
        const added = jest.spyOn(
            app.get(NotificationSseService),
            'addConnection',
        );
        const settle = () => new Promise((done) => setTimeout(done, 100));

        // The headers are sent before the unread count is read.
        await new Promise<void>((resolve, reject) => {
            const { port } = app.getHttpServer().address() as AddressInfo;
            request = http.get(
                { host: '127.0.0.1', port, path: '/notifications/stream' },
                () => resolve(),
            );
            request.on('error', reject);
        });
        request?.destroy();
        await settle();
        answer(3);
        await settle();

        expect(added).not.toHaveBeenCalled();
    });
});

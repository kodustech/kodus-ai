import { BitbucketController } from '../../../../apps/webhooks/src/controllers/bitbucket.controller';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';
import { Request, Response } from 'express';
import { HttpStatus } from '@nestjs/common';

describe('BitbucketController', () => {
    let controller: BitbucketController;
    let enqueueWebhookUseCase: jest.Mocked<EnqueueWebhookUseCase>;
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;

    beforeEach(() => {
        enqueueWebhookUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        } as any;

        controller = new BitbucketController(enqueueWebhookUseCase, {
            validate: jest.fn().mockReturnValue({ valid: true }),
        } as any);

        mockResponse = {
            status: jest.fn().mockReturnThis(),
            send: jest.fn().mockReturnThis(),
        };
    });

    describe('supported events', () => {
        it('should enqueue "pullrequest:created" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'pullrequest:created' },
                body: { pullrequest: { id: 1 } },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith('Webhook received');

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'BITBUCKET',
                event: 'pullrequest:created',
                payload: { pullrequest: { id: 1 }, isDataCenterEvent: false },
            });
        });

        it('should enqueue "pullrequest:updated" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'pullrequest:updated' },
                body: { pullrequest: { id: 1 } },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'BITBUCKET',
                event: 'pullrequest:updated',
                payload: { pullrequest: { id: 1 }, isDataCenterEvent: false },
            });
        });

        it('should enqueue "pullrequest:fulfilled" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'pullrequest:fulfilled' },
                body: { pullrequest: { id: 1 } },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalled();
        });

        it('should enqueue "pullrequest:rejected" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'pullrequest:rejected' },
                body: { pullrequest: { id: 1 } },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalled();
        });

        it('should enqueue "pullrequest:comment_created" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'pullrequest:comment_created' },
                body: {
                    pullrequest: { id: 1 },
                    comment: { content: { raw: '@kody review' } },
                },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'BITBUCKET',
                event: 'pullrequest:comment_created',
                payload: {
                    pullrequest: { id: 1 },
                    comment: { content: { raw: '@kody review' } },
                    isDataCenterEvent: false,
                },
            });
        });
    });

    describe('Data Center events', () => {
        /**
         * Bitbucket Data Center sends the pull request under `pullRequest`
         * (capital R), while Cloud sends `pullrequest`.
         * @see https://confluence.atlassian.com/bitbucketserver/event-payload-938025882.html
         */
        const dataCenterBody = {
            eventKey: 'pr:opened',
            pullRequest: {
                id: 1,
                title: 'a new file added',
                toRef: {
                    displayId: 'master',
                    repository: { id: 84, name: 'repo-1' },
                },
            },
        };

        it('should normalize the Data Center "pullRequest" key to "pullrequest"', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'pr:opened' },
                body: dataCenterBody,
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith('Webhook received');

            await new Promise((resolve) => setImmediate(resolve));

            const enqueued = enqueueWebhookUseCase.execute.mock.calls[0][0];

            expect(enqueued.payload.pullrequest).toEqual(
                dataCenterBody.pullRequest,
            );
            expect(enqueued.payload.isDataCenterEvent).toBe(true);
        });

        it.each([
            'pr:opened',
            'pr:modified',
            'pr:reviewer:updated',
            'pr:comment:added',
            'pr:merged',
            'pr:declined',
        ])('should enqueue "%s" with the normalized key', async (event) => {
            mockRequest = {
                headers: { 'x-event-key': event },
                body: { ...dataCenterBody, eventKey: event },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledTimes(1);

            const enqueued = enqueueWebhookUseCase.execute.mock.calls[0][0];

            expect(enqueued.event).toBe(event);
            expect(enqueued.payload.isDataCenterEvent).toBe(true);
            expect(enqueued.payload.pullrequest).toBeDefined();
        });

        it('should not invent a "pullrequest" key when Data Center sends none', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'pr:opened' },
                body: { eventKey: 'pr:opened' },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            const enqueued = enqueueWebhookUseCase.execute.mock.calls[0][0];

            expect(enqueued.payload.pullrequest).toBeUndefined();
            expect(enqueued.payload.isDataCenterEvent).toBe(true);
        });

        it('should not normalize "pullRequest" on a Cloud event', async () => {
            // A Cloud event whose body happens to carry a capital-R
            // `pullRequest` key must pass through untouched — normalization
            // is gated on the event being a Data Center one.
            mockRequest = {
                headers: { 'x-event-key': 'pullrequest:created' },
                body: {
                    pullrequest: { id: 1 },
                    pullRequest: { id: 999 },
                },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            const enqueued = enqueueWebhookUseCase.execute.mock.calls[0][0];

            expect(enqueued.payload.pullrequest).toEqual({ id: 1 });
            expect(enqueued.payload.isDataCenterEvent).toBe(false);
        });
    });

    describe('unsupported events - should NOT enqueue', () => {
        it('should ignore "repo:push" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'repo:push' },
                body: { push: { changes: [] } },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (event not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });

        it('should ignore "repo:fork" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'repo:fork' },
                body: { fork: {} },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (event not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });

        it('should ignore "issue:created" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'issue:created' },
                body: { issue: {} },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (event not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });

        it('should ignore "pullrequest:approved" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'pullrequest:approved' },
                body: { pullrequest: { id: 1 } },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (event not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });

        it('should ignore "pullrequest:unapproved" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'pullrequest:unapproved' },
                body: { pullrequest: { id: 1 } },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (event not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });

        it('should ignore "pullrequest:changes_request_created" event', async () => {
            mockRequest = {
                headers: {
                    'x-event-key': 'pullrequest:changes_request_created',
                },
                body: { pullrequest: { id: 1 } },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (event not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });
    });
});

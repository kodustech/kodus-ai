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

        controller = new BitbucketController(enqueueWebhookUseCase);

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

            controller.handleWebhook(
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

            controller.handleWebhook(
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

            controller.handleWebhook(
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

            controller.handleWebhook(
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

            controller.handleWebhook(
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

    describe('unsupported events - should NOT enqueue', () => {
        it('should ignore "repo:push" event', async () => {
            mockRequest = {
                headers: { 'x-event-key': 'repo:push' },
                body: { push: { changes: [] } },
            };

            controller.handleWebhook(
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

            controller.handleWebhook(
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

            controller.handleWebhook(
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

            controller.handleWebhook(
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

            controller.handleWebhook(
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

            controller.handleWebhook(
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

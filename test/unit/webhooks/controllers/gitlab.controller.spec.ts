import { GitlabController } from '../../../../apps/webhooks/src/controllers/gitlab.controller';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';
import { Request, Response } from 'express';
import { HttpStatus } from '@nestjs/common';

describe('GitlabController', () => {
    let controller: GitlabController;
    let enqueueWebhookUseCase: jest.Mocked<EnqueueWebhookUseCase>;
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;

    beforeEach(() => {
        enqueueWebhookUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        } as any;

        controller = new GitlabController(enqueueWebhookUseCase, {
            validate: jest.fn().mockReturnValue({ valid: true }),
        } as any);

        mockResponse = {
            status: jest.fn().mockReturnThis(),
            send: jest.fn().mockReturnThis(),
        };
    });

    describe('supported events', () => {
        it('should enqueue "Merge Request Hook" event', async () => {
            mockRequest = {
                headers: {
                    'x-gitlab-event': 'Merge Request Hook',
                    'x-gitlab-event-uuid': 'event-uuid-1',
                    'x-gitlab-webhook-uuid': 'hook-uuid-must-not-be-used',
                },
                body: {
                    object_kind: 'merge_request',
                    object_attributes: { iid: 1 },
                },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith('Webhook received');

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'GITLAB',
                event: 'Merge Request Hook',
                deliveryId: 'event-uuid-1',
                payload: {
                    object_kind: 'merge_request',
                    object_attributes: { iid: 1 },
                },
            });
        });

        it('should enqueue "Note Hook" event', async () => {
            mockRequest = {
                headers: { 'x-gitlab-event': 'Note Hook' },
                body: {
                    object_kind: 'note',
                    object_attributes: { note: '@kody review' },
                },
            };

            await controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith('Webhook received');

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'GITLAB',
                event: 'Note Hook',
                payload: {
                    object_kind: 'note',
                    object_attributes: { note: '@kody review' },
                },
            });
        });
    });

    describe('unsupported events - should NOT enqueue', () => {
        it('should ignore "Push Hook" event', async () => {
            mockRequest = {
                headers: { 'x-gitlab-event': 'Push Hook' },
                body: { object_kind: 'push', ref: 'refs/heads/main' },
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

        it('should ignore "Tag Push Hook" event', async () => {
            mockRequest = {
                headers: { 'x-gitlab-event': 'Tag Push Hook' },
                body: { object_kind: 'tag_push' },
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

        it('should ignore "Issue Hook" event', async () => {
            mockRequest = {
                headers: { 'x-gitlab-event': 'Issue Hook' },
                body: { object_kind: 'issue' },
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

        it('should ignore "Pipeline Hook" event', async () => {
            mockRequest = {
                headers: { 'x-gitlab-event': 'Pipeline Hook' },
                body: { object_kind: 'pipeline' },
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

        it('should ignore "Job Hook" event', async () => {
            mockRequest = {
                headers: { 'x-gitlab-event': 'Job Hook' },
                body: { object_kind: 'build' },
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

        it('should ignore "Wiki Page Hook" event', async () => {
            mockRequest = {
                headers: { 'x-gitlab-event': 'Wiki Page Hook' },
                body: { object_kind: 'wiki_page' },
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

        it('should ignore "Release Hook" event', async () => {
            mockRequest = {
                headers: { 'x-gitlab-event': 'Release Hook' },
                body: { object_kind: 'release' },
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

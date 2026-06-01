import { GithubController } from '../../../../apps/webhooks/src/controllers/github.controller';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';
import { Request, Response } from 'express';
import { HttpStatus } from '@nestjs/common';

describe('GithubController', () => {
    let controller: GithubController;
    let enqueueWebhookUseCase: jest.Mocked<EnqueueWebhookUseCase>;
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;

    beforeEach(() => {
        enqueueWebhookUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        } as any;

        controller = new GithubController(enqueueWebhookUseCase);

        mockResponse = {
            status: jest.fn().mockReturnThis(),
            send: jest.fn().mockReturnThis(),
        };
    });

    describe('supported events', () => {
        it('should enqueue pull_request event with "opened" action', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'pull_request' },
                body: { action: 'opened', pull_request: { number: 1 } },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith('Webhook received');

            // Wait for setImmediate
            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'GITHUB',
                event: 'pull_request',
                payload: { action: 'opened', pull_request: { number: 1 } },
            });
        });

        it('should enqueue pull_request event with "synchronize" action', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'pull_request' },
                body: { action: 'synchronize' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalled();
        });

        it('should enqueue pull_request event with "closed" action', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'pull_request' },
                body: { action: 'closed' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalled();
        });

        it('should enqueue pull_request event with "reopened" action', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'pull_request' },
                body: { action: 'reopened' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalled();
        });

        it('should enqueue pull_request event with "ready_for_review" action', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'pull_request' },
                body: { action: 'ready_for_review' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalled();
        });

        it('should enqueue issue_comment event', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'issue_comment' },
                body: { action: 'created', comment: { body: '@kody review' } },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'GITHUB',
                event: 'issue_comment',
                payload: {
                    action: 'created',
                    comment: { body: '@kody review' },
                },
            });
        });

        it('should enqueue pull_request_review_comment event', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'pull_request_review_comment' },
                body: { action: 'created', comment: { body: 'test' } },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'GITHUB',
                event: 'pull_request_review_comment',
                payload: { action: 'created', comment: { body: 'test' } },
            });
        });
    });

    describe('unsupported events - should NOT enqueue', () => {
        it('should ignore fork event', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'fork' },
                body: { forkee: {} },
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

        it('should ignore workflow_run event', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'workflow_run' },
                body: { action: 'completed' },
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

        it('should ignore issues event', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'issues' },
                body: { action: 'opened' },
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

        it('should ignore release event', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'release' },
                body: { action: 'published' },
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

    describe('unsupported pull_request actions - should NOT enqueue', () => {
        it('should ignore pull_request with "labeled" action', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'pull_request' },
                body: { action: 'labeled' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (action not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });

        it('should ignore pull_request with "assigned" action', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'pull_request' },
                body: { action: 'assigned' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (action not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });

        it('should ignore pull_request with "converted_to_draft" action', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'pull_request' },
                body: { action: 'converted_to_draft' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (action not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });

        it('should ignore pull_request with "review_requested" action', async () => {
            mockRequest = {
                headers: { 'x-github-event': 'pull_request' },
                body: { action: 'review_requested' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (action not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });
    });
});

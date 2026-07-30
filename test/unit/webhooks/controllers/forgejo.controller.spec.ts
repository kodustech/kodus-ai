import { ForgejoController } from '../../../../apps/webhooks/src/controllers/forgejo.controller';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';
import { Request, Response } from 'express';
import { HttpStatus } from '@nestjs/common';
import {
    forgejoPullRequestOpenedPayload,
    forgejoIssueCommentPayload,
    forgejoPullRequestReviewCommentPayload,
} from '../stubs/forgejo-webhook-stubs';

describe('ForgejoController', () => {
    let controller: ForgejoController;
    let enqueueWebhookUseCase: jest.Mocked<EnqueueWebhookUseCase>;
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;

    beforeEach(() => {
        enqueueWebhookUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        } as any;

        controller = new ForgejoController(enqueueWebhookUseCase);

        mockResponse = {
            status: jest.fn().mockReturnThis(),
            send: jest.fn().mockReturnThis(),
        };
    });

    describe('supported events', () => {
        it('should enqueue pull_request event with X-Forgejo-Event header', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'pull_request' },
                body: forgejoPullRequestOpenedPayload,
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
                platformType: 'FORGEJO',
                event: 'pull_request',
                payload: forgejoPullRequestOpenedPayload,
            });
        });

        it('should enqueue pull_request event with X-Gitea-Event header (backwards compatibility)', async () => {
            mockRequest = {
                headers: { 'x-gitea-event': 'pull_request' },
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
                platformType: 'FORGEJO',
                event: 'pull_request',
                payload: { action: 'opened', pull_request: { number: 1 } },
            });
        });

        it('should prefer X-Forgejo-Event over X-Gitea-Event when both are present', async () => {
            mockRequest = {
                headers: {
                    'x-forgejo-event': 'pull_request',
                    'x-gitea-event': 'issue_comment',
                },
                body: { action: 'opened' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'FORGEJO',
                event: 'pull_request',
                payload: { action: 'opened' },
            });
        });

        it('should enqueue pull_request event with synchronized action', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'pull_request' },
                body: { action: 'synchronized' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalled();
        });

        it('should enqueue pull_request event with reopened action', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'pull_request' },
                body: { action: 'reopened' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalled();
        });

        it('should enqueue pull_request event with closed action', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'pull_request' },
                body: { action: 'closed' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalled();
        });

        it('should enqueue pull_request event with X-GitHub-Event header (backwards compatibility)', async () => {
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

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'FORGEJO',
                event: 'pull_request',
                payload: { action: 'opened', pull_request: { number: 1 } },
            });
        });

        it('should enqueue pull_request event with X-Gogs-Event header (backwards compatibility)', async () => {
            mockRequest = {
                headers: { 'x-gogs-event': 'pull_request' },
                body: { action: 'opened', pull_request: { number: 1 } },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith('Webhook received');

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'FORGEJO',
                event: 'pull_request',
                payload: { action: 'opened', pull_request: { number: 1 } },
            });
        });

        it('should enqueue issue_comment event', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'issue_comment' },
                body: forgejoIssueCommentPayload,
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith('Webhook received');

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'FORGEJO',
                event: 'issue_comment',
                payload: forgejoIssueCommentPayload,
            });
        });

        it('should enqueue pull_request_review_comment event', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'pull_request_review_comment' },
                body: forgejoPullRequestReviewCommentPayload,
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith('Webhook received');

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'FORGEJO',
                event: 'pull_request_review_comment',
                payload: forgejoPullRequestReviewCommentPayload,
            });
        });
        it('should enqueue push event', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'push' },
                body: {
                    ref: 'refs/heads/main',
                    before: 'old-head-sha',
                    after: 'new-head-sha',
                },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith('Webhook received');

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'FORGEJO',
                event: 'push',
                payload: {
                    ref: 'refs/heads/main',
                    before: 'old-head-sha',
                    after: 'new-head-sha',
                },
            });
        });
    });

    describe('unsupported pull_request actions - should NOT enqueue', () => {
        it('should ignore pull_request with edited action', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'pull_request' },
                body: { action: 'edited' },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
            expect(mockResponse.send).toHaveBeenCalledWith(
                'Webhook ignored (action not supported)',
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });

        it('should ignore pull_request with assigned action', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'pull_request' },
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

        it('should ignore pull_request with labeled action', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'pull_request' },
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

        it('should ignore pull_request with review_requested action', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'pull_request' },
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

    describe('unsupported events - should NOT enqueue', () => {
        it('should ignore pull_request_review event (not the same as pull_request_review_comment)', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'pull_request_review' },
                body: { action: 'submitted', review: { state: 'approved' } },
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

        it('should ignore create event', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'create' },
                body: { ref: 'feature-branch', ref_type: 'branch' },
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

        it('should ignore delete event', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'delete' },
                body: { ref: 'feature-branch' },
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
                headers: { 'x-forgejo-event': 'issues' },
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
                headers: { 'x-forgejo-event': 'release' },
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

        it('should ignore fork event', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'fork' },
                body: { forkee: {} },
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

        it('should ignore repository event', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'repository' },
                body: { action: 'created' },
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

        it('should ignore wiki event', async () => {
            mockRequest = {
                headers: { 'x-forgejo-event': 'wiki' },
                body: { action: 'created' },
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

    describe('edge cases', () => {
        it('should handle missing event header', async () => {
            mockRequest = {
                headers: {},
                body: { action: 'opened' },
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
    });
});

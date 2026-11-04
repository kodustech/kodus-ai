import { AzureReposController } from '../../../../apps/webhooks/src/controllers/azureRepos.controller';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';
import { Request, Response } from 'express';
import { HttpStatus } from '@nestjs/common';

// Mock the validateWebhookToken function
jest.mock('@libs/common/utils/webhooks/webhookTokenCrypto', () => ({
    validateWebhookToken: jest.fn().mockReturnValue(true),
}));

import { validateWebhookToken } from '@libs/common/utils/webhooks/webhookTokenCrypto';

describe('AzureReposController', () => {
    let controller: AzureReposController;
    let enqueueWebhookUseCase: jest.Mocked<EnqueueWebhookUseCase>;
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;

    beforeEach(() => {
        jest.clearAllMocks();
        (validateWebhookToken as jest.Mock).mockReturnValue(true);

        enqueueWebhookUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        } as any;

        controller = new AzureReposController(enqueueWebhookUseCase);

        mockResponse = {
            status: jest.fn().mockReturnThis(),
            send: jest.fn().mockReturnThis(),
        };
    });

    describe('supported events', () => {
        it('should enqueue "git.pullrequest.created" event', async () => {
            mockRequest = {
                query: { token: 'valid-token' },
                body: {
                    eventType: 'git.pullrequest.created',
                    resource: { pullRequestId: 1 },
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
                platformType: 'AZURE_REPOS',
                event: 'git.pullrequest.created',
                payload: {
                    eventType: 'git.pullrequest.created',
                    resource: { pullRequestId: 1 },
                },
            });
        });

        it('should enqueue "git.pullrequest.updated" event', async () => {
            mockRequest = {
                query: { token: 'valid-token' },
                body: {
                    eventType: 'git.pullrequest.updated',
                    resource: { pullRequestId: 1 },
                },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'AZURE_REPOS',
                event: 'git.pullrequest.updated',
                payload: {
                    eventType: 'git.pullrequest.updated',
                    resource: { pullRequestId: 1 },
                },
            });
        });

        it('should enqueue "git.pullrequest.merge.attempted" event', async () => {
            mockRequest = {
                query: { token: 'valid-token' },
                body: {
                    eventType: 'git.pullrequest.merge.attempted',
                    resource: { pullRequestId: 1 },
                },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalled();
        });

        it('should enqueue "ms.vss-code.git-pullrequest-comment-event" event', async () => {
            mockRequest = {
                query: { token: 'valid-token' },
                body: {
                    eventType: 'ms.vss-code.git-pullrequest-comment-event',
                    resource: { comment: { content: '@kody review' } },
                },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            await new Promise((resolve) => setImmediate(resolve));

            expect(enqueueWebhookUseCase.execute).toHaveBeenCalledWith({
                platformType: 'AZURE_REPOS',
                event: 'ms.vss-code.git-pullrequest-comment-event',
                payload: {
                    eventType: 'ms.vss-code.git-pullrequest-comment-event',
                    resource: { comment: { content: '@kody review' } },
                },
            });
        });
    });

    describe('unsupported events - should NOT enqueue', () => {
        it('should ignore "git.pullrequest.approved" event', async () => {
            mockRequest = {
                query: { token: 'valid-token' },
                body: {
                    eventType: 'git.pullrequest.approved',
                    resource: { pullRequestId: 1 },
                },
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

    describe('validation', () => {
        it('should return 403 for invalid token', () => {
            (validateWebhookToken as jest.Mock).mockReturnValue(false);

            mockRequest = {
                query: { token: 'invalid-token' },
                body: {
                    eventType: 'git.pullrequest.created',
                    resource: {},
                },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(403);
            expect(mockResponse.send).toHaveBeenCalledWith('Unauthorized');
            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });

        it('should return 400 for missing eventType', () => {
            mockRequest = {
                query: { token: 'valid-token' },
                body: { resource: {} },
            };

            controller.handleWebhook(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockResponse.status).toHaveBeenCalledWith(
                HttpStatus.BAD_REQUEST,
            );
            expect(mockResponse.send).toHaveBeenCalledWith(
                'Unrecognized event',
            );
            expect(enqueueWebhookUseCase.execute).not.toHaveBeenCalled();
        });
    });
});

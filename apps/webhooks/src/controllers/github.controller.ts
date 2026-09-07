import { createLogger } from '@libs/core/log/logger';
import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Response } from 'express';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';
import {
    RawBodyRequest,
    WebhookSignatureService,
} from '../services/webhook-signature.service';

@Public()
@Controller('github')
export class GithubController {
    private readonly logger = createLogger(GithubController.name);

    constructor(
        private readonly enqueueWebhookUseCase: EnqueueWebhookUseCase,
        private readonly webhookSignatureService: WebhookSignatureService,
    ) {}

    @Post('/webhook')
    async handleWebhook(@Req() req: RawBodyRequest, @Res() res: Response) {
        const event = req.headers['x-github-event'] as string;
        const payload = req.body as any;

        const signature = this.webhookSignatureService.validate(
            PlatformType.GITHUB,
            req,
        );
        if (!signature.valid) {
            this.logger.warn({
                message: 'Rejected GitHub webhook with invalid signature',
                context: GithubController.name,
                metadata: { reason: signature.reason, event },
            });
            return res.status(HttpStatus.UNAUTHORIZED).send('Unauthorized');
        }

        // Filter unsupported events before enqueueing
        const supportedEvents = [
            'pull_request',
            'issue_comment',
            'pull_request_review_comment',
            'push',
        ];
        if (!supportedEvents.includes(event)) {
            return res
                .status(HttpStatus.OK)
                .send('Webhook ignored (event not supported)');
        }

        // For pull_request events, filter unsupported actions
        if (event === 'pull_request') {
            const allowedActions = [
                'opened',
                'synchronize',
                'closed',
                'reopened',
                'ready_for_review',
            ];
            if (!allowedActions.includes(payload?.action)) {
                return res
                    .status(HttpStatus.OK)
                    .send('Webhook ignored (action not supported)');
            }
        }

        try {
            const deliveryId = req.headers['x-github-delivery'] as string;
            const jobId = await this.enqueueWebhookUseCase.execute({
                platformType: PlatformType.GITHUB,
                event,
                payload,
                ...(deliveryId ? { deliveryId } : {}),
            });
            this.logger.log({
                message: `Webhook durably enqueued, ${event}`,
                context: GithubController.name,
                metadata: {
                    jobId,
                    event,
                    action: payload?.action,
                    commentId: payload?.comment?.id,
                    deliveryId,
                    installationId: payload?.installation?.id,
                    repository: payload?.repository?.name,
                },
            });
            return res.status(HttpStatus.OK).send('Webhook received');
        } catch (error) {
            this.logger.error({
                message: 'Error durably enqueuing webhook',
                context: GithubController.name,
                error,
                metadata: { event, platformType: PlatformType.GITHUB },
            });
            return res
                .status(HttpStatus.SERVICE_UNAVAILABLE)
                .send('Webhook persistence unavailable');
        }
    }
}

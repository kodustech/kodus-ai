import { createLogger } from '@libs/core/log/logger';
import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Response } from 'express';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';

import {
    WebhookForgejoEvent,
    WebhookForgejoHookIssueAction,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-forgejo.type';
import {
    RawBodyRequest,
    WebhookSignatureService,
} from '../services/webhook-signature.service';

@Public()
@Controller('forgejo')
export class ForgejoController {
    private readonly logger = createLogger(ForgejoController.name);

    constructor(
        private readonly enqueueWebhookUseCase: EnqueueWebhookUseCase,
        private readonly webhookSignatureService: WebhookSignatureService,
    ) {}

    @Post('/webhook')
    async handleWebhook(@Req() req: RawBodyRequest, @Res() res: Response) {
        // Forgejo uses X-Forgejo-Event header,
        // but also supports X-Gitea-Event, X-Gogs-Event and X-GitHub-Event for compatibility
        // @see https://forgejo.org/docs/next/user/webhooks/#event-information
        const event = (req.headers['x-forgejo-event'] ||
            req.headers['x-gitea-event'] ||
            req.headers['x-github-event'] ||
            req.headers['x-gogs-event']) as string;
        const payload = req.body as any;

        const signature = this.webhookSignatureService.validate(
            PlatformType.FORGEJO,
            req,
        );
        if (!signature.valid) {
            return res.status(HttpStatus.UNAUTHORIZED).send('Unauthorized');
        }

        // Filter unsupported events before enqueueing
        const supportedEvents: string[] = [
            WebhookForgejoEvent.PULL_REQUEST,
            WebhookForgejoEvent.ISSUE_COMMENT,
            WebhookForgejoEvent.PULL_REQUEST_REVIEW_COMMENT,
            WebhookForgejoEvent.PUSH,
        ];

        if (!supportedEvents.includes(event)) {
            return res
                .status(HttpStatus.OK)
                .send('Webhook ignored (event not supported)');
        }

        if (event === WebhookForgejoEvent.PULL_REQUEST) {
            const allowedActions: string[] = [
                WebhookForgejoHookIssueAction.OPENED,
                WebhookForgejoHookIssueAction.SYNCHRONIZED,
                WebhookForgejoHookIssueAction.REOPENED,
                WebhookForgejoHookIssueAction.CLOSED,
            ];

            if (!allowedActions.includes(payload?.action)) {
                return res
                    .status(HttpStatus.OK)
                    .send('Webhook ignored (action not supported)');
            }
        }

        try {
            const deliveryId = (req.headers['x-forgejo-delivery'] ||
                req.headers['x-gitea-delivery'] ||
                req.headers['x-gogs-delivery']) as string;
            const jobId = await this.enqueueWebhookUseCase.execute({
                platformType: PlatformType.FORGEJO,
                event,
                payload,
                ...(deliveryId ? { deliveryId } : {}),
            });
            this.logger.log({
                message: `Webhook durably enqueued, ${event}`,
                context: ForgejoController.name,
                metadata: {
                    jobId,
                    event,
                    repository: payload?.repository?.full_name,
                    action: payload?.action,
                },
            });
            return res.status(HttpStatus.OK).send('Webhook received');
        } catch (error) {
            this.logger.error({
                message: 'Error durably enqueuing webhook',
                context: ForgejoController.name,
                error,
                metadata: { event, platformType: PlatformType.FORGEJO },
            });
            return res
                .status(HttpStatus.SERVICE_UNAVAILABLE)
                .send('Webhook persistence unavailable');
        }
    }
}

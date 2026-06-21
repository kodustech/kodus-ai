import { createLogger } from '@kodus/flow';
import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';

import {
    WebhookForgejoEvent,
    WebhookForgejoHookIssueAction,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-forgejo.type';

@Public()
@Controller('forgejo')
export class ForgejoController {
    private readonly logger = createLogger(ForgejoController.name);

    constructor(
        private readonly enqueueWebhookUseCase: EnqueueWebhookUseCase,
    ) {}

    @Post('/webhook')
    handleWebhook(@Req() req: Request, @Res() res: Response) {
        // Forgejo uses X-Forgejo-Event header,
        // but also supports X-Gitea-Event, X-Gogs-Event and X-GitHub-Event for compatibility
        // @see https://forgejo.org/docs/next/user/webhooks/#event-information
        const event = (req.headers['x-forgejo-event'] ||
            req.headers['x-gitea-event'] ||
            req.headers['x-github-event'] ||
            req.headers['x-gogs-event']) as string;
        const payload = req.body as any;

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

        res.status(HttpStatus.OK).send('Webhook received');

        setImmediate(() => {
            void this.enqueueWebhookUseCase
                .execute({
                    platformType: PlatformType.FORGEJO,
                    event,
                    payload,
                })
                .then(() => {
                    this.logger.log({
                        message: `Webhook enqueued, ${event}`,
                        context: ForgejoController.name,
                        metadata: {
                            event,
                            repository: payload?.repository?.full_name,
                            action: payload?.action,
                        },
                    });
                })
                .catch((error) => {
                    this.logger.error({
                        message: 'Error enqueuing webhook',
                        context: ForgejoController.name,
                        error,
                        metadata: {
                            event,
                            platformType: PlatformType.FORGEJO,
                        },
                    });
                });
        });
    }
}

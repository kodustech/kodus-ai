import { createLogger } from '@kodus/flow';
import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';

@Public()
@Controller('github')
export class GithubController {
    private readonly logger = createLogger(GithubController.name);

    constructor(
        private readonly enqueueWebhookUseCase: EnqueueWebhookUseCase,
    ) {}

    @Post('/webhook')
    handleWebhook(@Req() req: Request, @Res() res: Response) {
        const event = req.headers['x-github-event'] as string;
        const payload = req.body as any;

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

        // Responde imediatamente (não bloqueia a request aguardando persistência/fila)
        res.status(HttpStatus.OK).send('Webhook received');

        setImmediate(() => {
            void this.enqueueWebhookUseCase
                .execute({
                    platformType: PlatformType.GITHUB,
                    event,
                    payload,
                })
                .then(() => {
                    this.logger.log({
                        message: `Webhook enqueued, ${event}`,
                        context: GithubController.name,
                        metadata: {
                            event,
                            action: payload?.action,
                            commentId: payload?.comment?.id,
                            deliveryId: req.headers['x-github-delivery'],
                            installationId: payload?.installation?.id,
                            repository: payload?.repository?.name,
                        },
                    });
                })
                .catch((error) => {
                    this.logger.error({
                        message: 'Error enqueuing webhook',
                        context: GithubController.name,
                        error,
                        metadata: {
                            event,
                            platformType: PlatformType.GITHUB,
                        },
                    });
                });
        });
    }
}

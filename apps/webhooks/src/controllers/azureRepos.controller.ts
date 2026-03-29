import { createLogger } from '@kodus/flow';
import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { validateWebhookToken } from '@libs/common/utils/webhooks/webhookTokenCrypto';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';

@Public()
@Controller('azure-repos')
export class AzureReposController {
    private readonly logger = createLogger(AzureReposController.name);

    constructor(
        private readonly enqueueWebhookUseCase: EnqueueWebhookUseCase,
    ) {}

    @Post('/webhook')
    handleWebhook(@Req() req: Request, @Res() res: Response) {
        const encrypted = req.query.token as string;

        if (!validateWebhookToken(encrypted)) {
            this.logger.error({
                message: 'Webhook Azure DevOps Not Token Valid',
                context: AzureReposController.name,
            });
            return res.status(403).send('Unauthorized');
        }

        const payload = req.body as any;
        const eventType = payload?.eventType as string;

        if (!eventType) {
            this.logger.log({
                message: 'Webhook Azure DevOps recebido sem eventType',
                context: AzureReposController.name,
                metadata: {
                    payloadKeys: Object.keys(payload || {}).slice(0, 30),
                },
            });
            return res
                .status(HttpStatus.BAD_REQUEST)
                .send('Unrecognized event');
        }

        // Filter unsupported events before enqueueing
        const supportedEvents = [
            'git.pullrequest.created',
            'git.pullrequest.updated',
            'git.pullrequest.merge.attempted',
            'ms.vss-code.git-pullrequest-comment-event',
        ];
        if (!supportedEvents.includes(eventType)) {
            return res
                .status(HttpStatus.OK)
                .send('Webhook ignored (event not supported)');
        }

        res.status(HttpStatus.OK).send('Webhook received');

        setImmediate(() => {
            void this.enqueueWebhookUseCase
                .execute({
                    platformType: PlatformType.AZURE_REPOS,
                    event: eventType,
                    payload,
                })
                .then(() => {
                    this.logger.log({
                        message: `Webhook enqueued, ${eventType}`,
                        context: AzureReposController.name,
                        metadata: {
                            event: eventType,
                            repositoryName: payload?.resource?.repository?.name,
                            pullRequestId: payload?.resource?.pullRequestId,
                            projectId: payload?.resourceContainers?.project?.id,
                        },
                    });
                })
                .catch((error) => {
                    this.logger.error({
                        message: 'Error enqueuing webhook',
                        context: AzureReposController.name,
                        error,
                        metadata: {
                            event: eventType,
                            platformType: PlatformType.AZURE_REPOS,
                        },
                    });
                });
        });
    }
}

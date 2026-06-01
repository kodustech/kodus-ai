import { createLogger } from '@kodus/flow';
import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { EnqueueWebhookUseCase } from '@libs/platform/application/use-cases/webhook/enqueue-webhook.use-case';

@Public()
@Controller('bitbucket')
export class BitbucketController {
    private readonly logger = createLogger(BitbucketController.name);

    constructor(
        private readonly enqueueWebhookUseCase: EnqueueWebhookUseCase,
    ) {}

    @Post('/webhook')
    handleWebhook(@Req() req: Request, @Res() res: Response) {
        const event = req.headers['x-event-key'] as string;
        const payload = req.body as any;

        // Filter unsupported events before enqueueing
        const supportedEvents = [
            // cloud
            'pullrequest:created',
            'pullrequest:updated',
            'pullrequest:fulfilled',
            'pullrequest:rejected',
            'pullrequest:comment_created',

            // data center
            'pr:opened',
            'pr:modified',
            'pr:reviewer:updated',
            'pr:comment:added',
            'pr:merged',
            'pr:declined',
        ];
        if (!supportedEvents.includes(event)) {
            return res
                .status(HttpStatus.OK)
                .send('Webhook ignored (event not supported)');
        }

        res.status(HttpStatus.OK).send('Webhook received');

        setImmediate(() => {
            const isDataCenterEvent = event.startsWith('pr:');

            void this.enqueueWebhookUseCase
                .execute({
                    platformType: PlatformType.BITBUCKET,
                    event,
                    payload: {
                        ...payload,
                        isDataCenterEvent,
                    },
                })
                .then(() => {
                    this.logger.log({
                        message: `Webhook enqueued, ${event}`,
                        context: BitbucketController.name,
                        metadata: {
                            event,
                            installationId: payload?.installation?.id,
                            repository: payload?.repository?.name,
                            isDataCenterEvent,
                        },
                    });
                })
                .catch((error) => {
                    this.logger.error({
                        message: 'Error enqueuing webhook',
                        context: BitbucketController.name,
                        error,
                        metadata: {
                            event,
                            platformType: PlatformType.BITBUCKET,
                            isDataCenterEvent,
                        },
                    });
                });
        });
    }
}

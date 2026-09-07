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
@Controller('bitbucket')
export class BitbucketController {
    private readonly logger = createLogger(BitbucketController.name);

    constructor(
        private readonly enqueueWebhookUseCase: EnqueueWebhookUseCase,
        private readonly webhookSignatureService: WebhookSignatureService,
    ) {}

    @Post('/webhook')
    async handleWebhook(@Req() req: RawBodyRequest, @Res() res: Response) {
        const event = req.headers['x-event-key'] as string;
        const payload = req.body as any;

        const signature = this.webhookSignatureService.validate(
            PlatformType.BITBUCKET,
            req,
        );
        if (!signature.valid) {
            return res.status(HttpStatus.UNAUTHORIZED).send('Unauthorized');
        }

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

        const isDataCenterEvent = event.startsWith('pr:');

        try {
            const deliveryId = req.headers['x-request-uuid'] as string;
            const jobId = await this.enqueueWebhookUseCase.execute({
                platformType: PlatformType.BITBUCKET,
                event,
                payload: {
                    ...payload,
                    // Bitbucket Data Center sends the pull request under
                    // `pullRequest` (capital R), while Cloud sends `pullrequest`.
                    // Normalize once here so the mappers and the handler can rely
                    // on a single key.
                    // https://confluence.atlassian.com/bitbucketserver/event-payload-938025882.html
                    ...(isDataCenterEvent && payload?.pullRequest
                        ? { pullrequest: payload.pullRequest }
                        : {}),
                    isDataCenterEvent,
                },
                ...(deliveryId ? { deliveryId } : {}),
            });
            this.logger.log({
                message: `Webhook durably enqueued, ${event}`,
                context: BitbucketController.name,
                metadata: {
                    jobId,
                    event,
                    installationId: payload?.installation?.id,
                    repository: payload?.repository?.name,
                    isDataCenterEvent,
                },
            });
            return res.status(HttpStatus.OK).send('Webhook received');
        } catch (error) {
            this.logger.error({
                message: 'Error durably enqueuing webhook',
                context: BitbucketController.name,
                error,
                metadata: {
                    event,
                    platformType: PlatformType.BITBUCKET,
                    isDataCenterEvent,
                },
            });
            return res
                .status(HttpStatus.SERVICE_UNAVAILABLE)
                .send('Webhook persistence unavailable');
        }
    }
}

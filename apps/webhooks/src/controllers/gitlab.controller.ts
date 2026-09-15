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
@Controller('gitlab')
export class GitlabController {
    private readonly logger = createLogger(GitlabController.name);
    constructor(
        private readonly enqueueWebhookUseCase: EnqueueWebhookUseCase,
        private readonly webhookSignatureService: WebhookSignatureService,
    ) {}

    @Post('/webhook')
    async handleWebhook(@Req() req: RawBodyRequest, @Res() res: Response) {
        const event = req.headers['x-gitlab-event'] as string;
        const payload = req.body as any;

        const signature = this.webhookSignatureService.validate(
            PlatformType.GITLAB,
            req,
        );
        if (!signature.valid) {
            return res.status(HttpStatus.UNAUTHORIZED).send('Unauthorized');
        }

        // Filter unsupported events before enqueueing
        const supportedEvents = ['Merge Request Hook', 'Note Hook'];
        if (!supportedEvents.includes(event)) {
            return res
                .status(HttpStatus.OK)
                .send('Webhook ignored (event not supported)');
        }

        try {
            // Event UUID identifies this event across delivery attempts.
            // Webhook UUID identifies the hook configuration itself and must
            // never be used here or every event from one hook would collapse.
            const deliveryId = (req.headers['x-gitlab-event-uuid'] ||
                req.headers['x-request-id']) as string;
            const jobId = await this.enqueueWebhookUseCase.execute({
                platformType: PlatformType.GITLAB,
                event,
                payload,
                ...(deliveryId ? { deliveryId } : {}),
            });
            this.logger.log({
                message: `Webhook durably enqueued, ${event}`,
                context: GitlabController.name,
                metadata: {
                    jobId,
                    event,
                    installationId: payload?.installation?.id,
                    repository: payload?.repository?.name,
                },
            });
            return res.status(HttpStatus.OK).send('Webhook received');
        } catch (error) {
            this.logger.error({
                message: 'Error durably enqueuing webhook',
                context: GitlabController.name,
                error,
                metadata: { event, platformType: PlatformType.GITLAB },
            });
            return res
                .status(HttpStatus.SERVICE_UNAVAILABLE)
                .send('Webhook persistence unavailable');
        }
    }
}

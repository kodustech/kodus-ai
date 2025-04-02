import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { PinoLoggerService } from '../../adapters/services/logger/pino.service';
import { Response } from 'express';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { ReceiveWebhookUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/receiveWebhook.use-case';

@Controller('gitlab')
export class GitlabController {
    constructor(
        private logger: PinoLoggerService,
        private readonly receiveWebhookUseCase: ReceiveWebhookUseCase,
    ) {}

    @Post('/webhook')
    handleWebhook(@Req() req: Request, @Res() res: Response) {
        const event = req.headers['x-gitlab-event'] as string;
        const payload = req.body as any;

        setImmediate(() => {
            this.logger.log({
                message: `Webhook received, ${event}`,
                context: GitlabController.name,
                metadata: {
                    event,
                    installationId: payload?.installation?.id,
                    repository: payload?.repository?.name,
                },
            });
            this.receiveWebhookUseCase.execute({
                payload,
                event,
                platformType: PlatformType.GITLAB,
            });
        });

        console.log('@event webhook', event);
        console.log('Webhook received');
        return res.status(HttpStatus.OK).send('Webhook received');
    }
}

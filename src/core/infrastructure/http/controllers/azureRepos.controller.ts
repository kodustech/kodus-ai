import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Response, Request } from 'express';
import { PinoLoggerService } from '../../adapters/services/logger/pino.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { ReceiveWebhookUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/receiveWebhook.use-case';
import { validateWebhookToken } from '@/shared/utils/webhooks/webhookTokenCrypto';

@Controller('azure-repos')
export class AzureReposController {
    constructor(
        private readonly receiveWebhookUseCase: ReceiveWebhookUseCase,
        private logger: PinoLoggerService,
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

        // Verificar se recebemos um tipo de evento válido
        if (!eventType) {
            this.logger.log({
                message: 'Webhook Azure DevOps recebido sem eventType',
                context: AzureReposController.name,
                metadata: { payload },
            });
            return res
                .status(HttpStatus.BAD_REQUEST)
                .send('Evento não reconhecido');
        }

        setImmediate(() => {
            this.logger.log({
                message: `Webhook received, ${eventType}`,
                context: AzureReposController.name,
                metadata: {
                    event: eventType,
                    repositoryName: payload?.resource?.repository?.name,
                    pullRequestId: payload?.resource?.pullRequestId,
                    projectId: payload?.resourceContainers?.project?.id,
                },
            });

            this.receiveWebhookUseCase.execute({
                payload,
                event: eventType,
                platformType: PlatformType.AZURE_REPOS,
            });
        });

        console.log('@event azure webhook', eventType);
        console.log('Webhook received');
        return res.status(HttpStatus.OK).send('Webhook received');
    }
}

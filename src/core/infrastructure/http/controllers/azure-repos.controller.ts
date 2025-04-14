import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { PinoLoggerService } from '../../adapters/services/logger/pino.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { ReceiveWebhookUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/receiveWebhook.use-case';

@Controller('azure-repos')
export class AzureReposController {
    constructor(
        private readonly receiveWebhookUseCase: ReceiveWebhookUseCase,
        private logger: PinoLoggerService,
    ) {}

    @Post('/webhook')
    handleWebhook(@Req() req: Request, @Res() res: Response) {
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

import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

@Injectable()
export class SendRulesNotificationUseCase {
    private readonly logger = createLogger(SendRulesNotificationUseCase.name);
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        private readonly notificationService: NotificationService,
    ) {}

    async execute(organizationId: string, rules: string[]): Promise<void> {
        try {
            this.logger.log({
                message: 'Starting Kody Rules notification process',
                context: SendRulesNotificationUseCase.name,
                metadata: {
                    organizationId,
                    rulesCount: rules.length,
                },
            });

            // Validar se há regras para notificar
            if (!rules || rules.length === 0) {
                this.logger.log({
                    message: 'No rules to notify',
                    context: SendRulesNotificationUseCase.name,
                    metadata: { organizationId },
                });
                return;
            }

            // Buscar usuários ativos da organização
            const users = await this.usersService.find(
                {
                    organization: { uuid: organizationId },
                },
                [STATUS.ACTIVE],
            );

            if (!users || users.length === 0) {
                this.logger.log({
                    message: 'No active users found in organization',
                    context: SendRulesNotificationUseCase.name,
                    metadata: { organizationId },
                });
                return;
            }

            // Buscar dados da organização
            const organization = await this.organizationService.findOne({
                uuid: organizationId,
            });

            if (!organization) {
                this.logger.error({
                    message: 'Organization not found',
                    context: SendRulesNotificationUseCase.name,
                    metadata: { organizationId },
                });
                return;
            }

            // Formatar dados dos usuários para o notification payload
            const emailUsers = users.map((user) => ({
                email: user.email,
                name: this.extractUserName(user),
            }));

            this.logger.log({
                message: 'Emitting Kody Rules notification',
                context: SendRulesNotificationUseCase.name,
                metadata: {
                    organizationId,
                    usersCount: emailUsers.length,
                    rulesCount: rules.length,
                    organizationName: organization.name,
                },
            });

            // Emit via the centralized notification engine. The
            // dispatcher fans out to each recipient and routes per
            // channel. `users` stays in the payload for the email
            // template (the recap lists everyone who got it).
            await this.notificationService.emit({
                event: NotificationEvent.KODY_RULES_GENERATED,
                payload: {
                    users: emailUsers,
                    rules,
                    organizationName: organization.name,
                },
                organizationId,
                recipients: users.map((u) => ({
                    kind: 'user',
                    userId: u.uuid,
                })),
            });

            this.logger.log({
                message: 'Kody Rules notification emitted successfully',
                context: SendRulesNotificationUseCase.name,
                metadata: { organizationId },
            });
        } catch (error) {
            this.logger.error({
                message: 'Error in Kody Rules notification process',
                context: SendRulesNotificationUseCase.name,
                error,
                metadata: {
                    organizationId,
                    rulesCount: rules?.length || 0,
                },
            });
            // Não propagar o erro para não interromper o processo principal
        }
    }

    private extractUserName(user: any): string {
        // Tentar extrair o nome do usuário de diferentes fontes
        if (user.teamMember && user.teamMember.length > 0) {
            return user.teamMember[0].name || user.email.split('@')[0];
        }
        return user.email.split('@')[0];
    }
}


import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';

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
import { ConnectionAccessService } from '@libs/identity/infrastructure/adapters/services/permissions/connection-access.service';
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
        @Optional()
        private readonly connectionAccess?: ConnectionAccessService,
    ) {}

    async execute(
        organizationId: string,
        rules: Array<string | { title: string; repositoryId?: string }>,
    ): Promise<void> {
        const entries = (rules ?? []).map((rule) =>
            typeof rule === 'string' ? { title: rule } : rule,
        ) as Array<{ title: string; repositoryId?: string }>;
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

            // A member granted only some Git connections hears only about
            // the rules of those connections' repositories, so members are
            // grouped by the rules they may see and each group gets its own.
            const groups = new Map<
                string,
                { titles: string[]; users: typeof users }
            >();
            const scopes = await Promise.allSettled(
                users.map((user) =>
                    this.connectionAccess?.restrictionFor({
                        uuid: user.uuid,
                        role: user.role,
                        organization: { uuid: organizationId },
                    }),
                ),
            );
            for (const [index, user] of users.entries()) {
                const scope = scopes[index];
                // A member whose access could not be read hears nothing.
                if (scope.status === 'rejected') continue;
                const restriction = scope.value;
                const titles = entries
                    .filter(
                        (rule) =>
                            !restriction ||
                            !rule.repositoryId ||
                            rule.repositoryId === 'global' ||
                            restriction.allowsRepository({
                                id: rule.repositoryId,
                            }),
                    )
                    .map((rule) => rule.title);
                if (titles.length === 0) continue;
                const key = titles.join('\u0000');
                const group = groups.get(key) ?? { titles, users: [] };
                group.users.push(user);
                groups.set(key, group);
            }

            this.logger.log({
                message: 'Emitting Kody Rules notification',
                context: SendRulesNotificationUseCase.name,
                metadata: {
                    organizationId,
                    usersCount: users.length,
                    rulesCount: rules.length,
                    groups: groups.size,
                    organizationName: organization.name,
                },
            });

            // Emit via the centralized notification engine. The
            // dispatcher fans out to each recipient and routes per
            // channel. `users` stays in the payload for the email
            // template (the recap lists everyone who got it).
            for (const group of groups.values()) {
                await this.notificationService.emit({
                    event: NotificationEvent.KODY_RULES_GENERATED,
                    payload: {
                        users: group.users.map((user) => ({
                            email: user.email,
                            name: this.extractUserName(user),
                        })),
                        rules: group.titles,
                        organizationName: organization.name,
                    },
                    organizationId,
                    recipients: group.users.map((u) => ({
                        kind: 'user',
                        userId: u.uuid,
                    })),
                });
            }

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


import { Inject, Injectable } from '@nestjs/common';

import { STATUS } from '@/config/types/database/status.type';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@/core/domain/user/contracts/user.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { sendKodyRulesNotification } from '@/shared/utils/email/sendMail';

interface RuleInfo {
    title: string;
    rule: string;
    severity: string;
}

@Injectable()
export class SendRulesNotificationUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(organizationId: string, rules: RuleInfo[]) {
        try {
            if (!rules || rules.length === 0) {
                this.logger.log({
                    message: 'No rules to notify',
                    context: SendRulesNotificationUseCase.name,
                    metadata: { organizationId },
                });
                return;
            }

            const users = await this.usersService.find(
                { organization: { uuid: organizationId } },
                [STATUS.ACTIVE],
            );

            if (!users || users.length === 0) {
                this.logger.log({
                    message: 'No active users found for organization',
                    context: SendRulesNotificationUseCase.name,
                    metadata: { organizationId },
                });
                return;
            }

            const data = users.map((u) => ({
                email: u.email,
                name: u.teamMember?.[0]?.name || u.email,
            }));

            await sendKodyRulesNotification(data, rules);

            this.logger.log({
                message: 'Sent Kody rules notification',
                context: SendRulesNotificationUseCase.name,
                metadata: { organizationId, rules: rules.length, users: data.length },
            });
        } catch (error) {
            this.logger.error({
                message: 'Error sending Kody rules notification',
                context: SendRulesNotificationUseCase.name,
                error,
                metadata: { organizationId },
            });
        }
    }
}


import { createLogger } from '@kodus/flow';
import {
    Inject,
    Injectable,
    UnauthorizedException,
    InternalServerErrorException,
} from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

@Injectable()
export class ResendEmailUseCase implements IUseCase {
    private readonly logger = createLogger(ResendEmailUseCase.name);
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
        private readonly notificationService: NotificationService,
    ) {}

    async execute(email: string): Promise<{ message: string }> {
        try {
            const user = await this.usersService.findOne({
                email,
            });

            if (!user) {
                throw new UnauthorizedException('User not found');
            }

            const token = await this.authService.createEmailToken(
                user.uuid,
                user.email,
            );

            await this.notificationService.emit({
                event: NotificationEvent.AUTH_EMAIL_CONFIRMATION,
                payload: {
                    token,
                    email: user.email,
                    organizationName: user.organization.name,
                    organizationAndTeamData: {
                        organizationId: user.organization.uuid,
                    },
                },
                organizationId: user.organization.uuid,
                recipients: { kind: 'user', userId: user.uuid },
            });

            return { message: 'Email sent successfully' };
        } catch (error) {
            this.logger.error({
                message: 'Something went wrong while confirming email',
                context: ResendEmailUseCase.name,
                error,
            });
            throw new InternalServerErrorException(
                'Something went wrong while resending email',
            );
        }
    }
}

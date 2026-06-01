import { createLogger } from '@kodus/flow';
import {
    Inject,
    Injectable,
    InternalServerErrorException,
    NotFoundException,
} from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

@Injectable()
export class ForgotPasswordUseCase implements IUseCase {
    private readonly logger = createLogger(ForgotPasswordUseCase.name);
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        private readonly notificationService: NotificationService,
    ) {}

    async execute(email: string) {
        try {
            const user = await this.authService.validateUser({ email });
            if (!user) {
                throw new NotFoundException('User Not found.');
            }
            const token = await this.authService.createForgotPassToken(
                user.uuid,
                email,
            );
            await this.notificationService.emit({
                event: NotificationEvent.AUTH_FORGOT_PASSWORD,
                payload: {
                    email: user.email,
                    name: user.organization.name,
                    token,
                },
                organizationId: user.organization.uuid,
                recipients: { kind: 'user', userId: user.uuid },
            });
            return { message: 'Reset link sent.' };
        } catch {
            throw new InternalServerErrorException(
                'Failed to send reset link.',
            );
        }
    }
}

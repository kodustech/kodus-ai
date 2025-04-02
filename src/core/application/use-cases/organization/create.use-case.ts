import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';
import { IOrganization } from '@/core/domain/organization/interfaces/organization.interface';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { CreateUserUseCase } from '../user/create.use-case';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { SaveCheckinConfigUseCase } from '../checkin/save-checkin-config.use-case';
import { DuplicateRecordException } from '@/shared/infrastructure/filters/duplicate-record.exception';
import {
    USER_SERVICE_TOKEN,
    IUsersService,
} from '@/core/domain/user/contracts/user.service.contract';
import { identify, track } from '@/shared/utils/segment';
import { generateRandomOrgName } from '@/shared/utils/helpers';

@Injectable()
export class CreateOrganizationUseCase implements IUseCase {
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        private readonly createUserUseCase: CreateUserUseCase,

        private logger: PinoLoggerService,
    ) {}

    public async execute(
        payload: any,
        user: Partial<IUser>,
    ): Promise<Partial<IUser>> {
        try {
            let createdOrganization: IOrganization;

            await this.checkIfUserAlreadyExists(user.email);

            if (!user?.organization?.name) {
                user.organization = {
                    name: generateRandomOrgName(payload.name),
                };
            }

            await this.checkIfOrganizationAlreadyExists(user.organization.name);

            createdOrganization =
                await this.organizationService.createOrganizationWithTenant(
                    user.organization,
                );

            const userWithOrganization = {
                ...user,
                organization: {
                    uuid: createdOrganization.uuid,
                    name: createdOrganization.name,
                },
            };

            const userCreated = await this.createUserUseCase.execute({
                ...payload,
                ...userWithOrganization,
            });

            identify(userCreated.uuid, {
                name: payload.name,
                email: user.email,
                organizationId: createdOrganization.uuid,
                organizationName: createdOrganization.name,
            });

            track(userCreated.uuid, 'signed_up');

            await this.sendWebhook(user, payload, createdOrganization.name);

            return userCreated;
        } catch (error) {
            throw error;
        }
    }

    private async sendWebhook(
        user: Partial<IUser>,
        payload: any,
        organizationName: string,
    ): Promise<void> {
        const webhookUrl = process.env.API_SIGNUP_NOTIFICATION_WEBHOOK;

        if (!webhookUrl) {
            return;
        }

        try {
            const webhookData = {
                email: user?.email,
                organization: organizationName,
                name: payload.name,
                phone: payload.phone,
            };

            if (!webhookData.email || !webhookData.organization) {
                throw new Error('Invalid data for webhook');
            }

            let response;
            let retries = 3;
            while (retries > 0) {
                response = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(webhookData),
                });

                if (response.ok) {
                    break;
                }
                console.error(
                    `Failed to send webhook (${retries} attempts remaining):`,
                    response.statusText,
                );
                await new Promise((resolve) => setTimeout(resolve, 1000));
                retries--;
            }
            if (retries === 0) {
                throw new Error('Error calling signup notification webhook');
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to send webhook.',
                context: SaveCheckinConfigUseCase.name,
                error: error,
            });
        }
    }

    private async checkIfUserAlreadyExists(email: string): Promise<boolean> {
        const previousUser = await this.usersService.count({
            email: email,
        });

        if (previousUser) {
            throw new DuplicateRecordException(
                'An user with this e-mail already exists.',
                'DUPLICATE_USER_EMAIL',
            );
        }

        return false;
    }

    private async checkIfOrganizationAlreadyExists(
        organizationName: string,
    ): Promise<boolean> {
        const existingOrganization = await this.organizationService.findOne({
            name: organizationName,
        });

        if (existingOrganization) {
            throw new DuplicateRecordException(
                'An organization with this name already exists.',
                'DUPLICATE_ORGANIZATION_NAME',
            );
        }

        return false;
    }
}

import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { environment } from '@libs/ee/configs/environment';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { DuplicateRecordException } from '@libs/core/infrastructure/filters/duplicate-record.exception';
import { EmailService } from '@libs/common/email/services/email.service';
import { generateRandomOrgName } from '@libs/common/utils/helpers';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    USER_SERVICE_TOKEN,
    IUsersService,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import {
    ORGANIZATION_SERVICE_TOKEN,
    IOrganizationService,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { ITeam } from '@libs/organization/domain/team/interfaces/team.interface';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';
import { TeamMemberRole } from '@libs/organization/domain/teamMembers/enums/teamMemberRole.enum';

import { CreateProfileUseCase } from '../profile/create.use-case';
import { CreateTeamUseCase } from '@libs/organization/application/use-cases/team/create.use-case';
import { SignUpDTO } from '@libs/identity/dtos/create-user-organization.dto';

export interface SignUpOptions {
    preVerified?: boolean;
}

@Injectable()
export class SignUpUseCase implements IUseCase {
    private readonly logger = createLogger(SignUpUseCase.name);
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        private readonly createProfileUseCase: CreateProfileUseCase,
        private readonly createTeamUseCase: CreateTeamUseCase,
        private readonly emailService: EmailService,
        private readonly telemetry: TelemetryService,
    ) {}

    public async execute(
        payload: SignUpDTO,
        options?: SignUpOptions,
    ): Promise<Partial<IUser>> {
        const { email, password, name, organizationId } = payload;

        this.logger.error({
            message: 'TEST LOG: Starting signup process',
            context: SignUpUseCase.name,
            metadata: { email, organizationId, name },
        });

        try {
            const userExists = await this.checkIfUserAlreadyExists(email);
            if (userExists) {
                throw new DuplicateRecordException('User already exists');
            }

            const status =
                options?.preVerified || !environment.API_CLOUD_MODE
                    ? STATUS.ACTIVE
                    : STATUS.PENDING;
            const user: Omit<IUser, 'uuid'> = {
                email,
                password,
                role: Role.CONTRIBUTOR,
                status,
                organization: {
                    name: generateRandomOrgName(name),
                },
            };

            if (organizationId && organizationId.length > 0) {
                user.organization = await this.organizationService.findOne({
                    uuid: organizationId,
                });
            } else {
                const orgExists = await this.checkIfOrganizationAlreadyExists(
                    user.organization.name,
                );

                if (orgExists) {
                    throw new DuplicateRecordException(
                        'Organization with this name already exists',
                    );
                }

                user.role = Role.OWNER;
                user.status = STATUS.ACTIVE;
                user.organization =
                    await this.organizationService.createOrganizationWithTenant(
                        user.organization,
                    );
            }

            if (!user.organization) {
                throw new Error('Organization not found');
            }

            const createdUser = await this.usersService.register(user);

            if (!createdUser) {
                throw new Error('User creation failed');
            }

            await this.createProfileUseCase.execute({
                user: { uuid: createdUser.uuid },
                name,
            });

            let team: ITeam;
            const isOwner = user.role === Role.OWNER;
            if (isOwner) {
                team = await this.createTeamUseCase.execute({
                    teamName: `${name} - team`,
                    organizationId: createdUser.organization.uuid,
                    organizationName: createdUser.organization.name,
                    actorUserId: createdUser.uuid,
                });

                if (!team) {
                    throw new Error('Team creation failed');
                }
            } else {
                team = await this.teamService.findOne({
                    organization: {
                        uuid: createdUser.organization.uuid,
                    },
                });

                if (!team) {
                    throw new Error('Team not found for the organization');
                }
            }

            const member = await this.teamMembersService.create({
                user: createdUser,
                name,
                organization: createdUser.organization,
                team,
                teamRole: isOwner
                    ? TeamMemberRole.TEAM_LEADER
                    : TeamMemberRole.MEMBER,
                status: isOwner || !!options?.preVerified,
            });

            if (!member) {
                throw new Error('Failed to create team member');
            }

            void this.emailService.createContact({ email, name }, this.logger);

            void this.telemetry.userSignedUp({
                userId: createdUser.uuid,
                email,
                name,
                organizationId: createdUser.organization.uuid,
                organizationName: createdUser.organization.name,
                teamId: team.uuid,
                teamName: team.name,
            });

            return createdUser.toObject();
        } catch (error) {
            this.logger.error({
                message: 'Error during sign up',
                error,
                context: SignUpUseCase.name,
                metadata: {
                    name,
                    email,
                    organizationId,
                },
                serviceName: SignUpUseCase.name,
            });

            throw error;
        }
    }

    private async checkIfUserAlreadyExists(email: string): Promise<boolean> {
        const previousUser = await this.usersService.count({
            email: email,
        });

        return !!previousUser;
    }

    private async checkIfOrganizationAlreadyExists(
        organizationName: string,
    ): Promise<boolean> {
        const existingOrganization = await this.organizationService.findOne({
            name: organizationName,
        });

        return !!existingOrganization;
    }
}

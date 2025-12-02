import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@/core/domain/auth/contracts/auth.service.contracts';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { TeamMemberRole } from '@/core/domain/teamMembers/enums/teamMemberRole.enum';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@/core/domain/user/contracts/user.service.contract';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { GetOrganizationsByDomainUseCase } from '@/core/application/use-cases/organization/get-organizations-domain.use-case';
import { SignUpUseCase } from './signup.use-case';
import { SSOConfig } from '@/core/domain/organizationParameters/types/sso-config.type';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';

@Injectable()
export class SSOLoginUseCase {
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly signUpUseCase: SignUpUseCase,
        private readonly getOrganizationsByDomainUseCase: GetOrganizationsByDomainUseCase,
        private readonly logger: PinoLoggerService,
    ) { }

    public async execute(
        code: string,
        state: string,
    ): Promise<{ accessToken: string; refreshToken: string }> {
        try {
            const stateJson = JSON.parse(decodeURIComponent(state));
            const organizationId = stateJson.organizationId;

            if (!organizationId) {
                throw new UnauthorizedException('Invalid state: missing organizationId');
            }

            // 1. Get SSO Config for the organization
            const orgParams = await this.organizationParametersService.findByKeyAndValue({
                configKey: OrganizationParametersKey.SSO_CONFIG,
                configValue: { enabled: true },
                fuzzy: true,
            });

            const orgConfig = orgParams.find(
                (p) => p.organization.uuid === organizationId,
            );

            if (!orgConfig) {
                throw new UnauthorizedException('SSO not enabled for this organization');
            }

            const ssoConfig = orgConfig.configValue as SSOConfig;

            // 2. Exchange code for tokens
            const tokenResponse = await axios.post(
                'https://oauth2.googleapis.com/token',
                {
                    code,
                    client_id: ssoConfig.clientId,
                    client_secret: ssoConfig.clientSecret,
                    redirect_uri: ssoConfig.redirectUris[0],
                    grant_type: 'authorization_code',
                },
            );

            const { id_token, refresh_token } = tokenResponse.data;

            // 3. Verify ID Token and get email (Simplified: just decode for now, in prod verify signature)
            // Using google's tokeninfo endpoint for verification is safer
            const tokenInfo = await axios.get(
                `https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`,
            );

            const email = tokenInfo.data.email;
            const name = tokenInfo.data.name || email.split('@')[0];

            if (!email) {
                throw new UnauthorizedException('Could not retrieve email from ID token');
            }

            // 4. Find or Create User
            let user = await this.authService.validateUser({ email });

            if (!user || !user.uuid) {
                // Create user and add to the SSO organization
                user = await this.signUpUseCase.execute({
                    email,
                    name,
                    password: randomBytes(32).toString('base64').slice(0, 32),
                    organizationId,
                });
            } else {
                // Ensure user is member of the SSO organization
                await this.ensureOrganizationMembership(user as IUser, organizationId);
            }

            // 5. Auto Join Logic (for OTHER organizations)
            const domain = email.split('@')[1];
            const autoJoinOrgs = await this.getOrganizationsByDomainUseCase.execute(domain);

            for (const org of autoJoinOrgs) {
                if (org.uuid !== organizationId) {
                    await this.ensureOrganizationMembership(user as IUser, org.uuid);
                }
            }

            // 6. Login
            const tokens = await this.authService.login(
                user as IUser,
                AuthProvider.GOOGLE,
                { refreshToken: refresh_token },
            );

            return tokens;
        } catch (error) {
            this.logger.error({
                message: 'SSO Login failed',
                error,
                context: SSOLoginUseCase.name,
            });
            throw new UnauthorizedException('SSO Login failed');
        }
    }

    private async ensureOrganizationMembership(user: IUser, organizationId: string) {
        const member = await this.teamMembersService.findOne({
            user: { uuid: user.uuid },
            organization: { uuid: organizationId },
        });

        if (!member) {
            const organization = await this.organizationService.findOne({
                uuid: organizationId,
            });

            const team = await this.teamService.findOne({
                organization: { uuid: organizationId },
            });

            if (organization && team) {
                await this.teamMembersService.create({
                    user,
                    name: user.email,
                    organization,
                    team,
                    teamRole: TeamMemberRole.MEMBER,
                    status: true,
                });
            }
        }
    }
}

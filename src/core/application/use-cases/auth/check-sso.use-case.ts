import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { SSOConfig } from '@/core/domain/organizationParameters/types/sso-config.type';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class CheckSSOUseCase implements IUseCase {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly logger: PinoLoggerService,
    ) { }

    public async execute(email: string): Promise<{
        ssoEnabled: boolean;
        redirectUrl?: string;
        organizationId?: string;
    }> {
        try {
            if (!email) {
                return { ssoEnabled: false };
            }

            const domain = email.split('@')[1];
            if (!domain) {
                return { ssoEnabled: false };
            }

            const ssoConfigs =
                await this.organizationParametersService.findByKeyAndValue({
                    configKey: OrganizationParametersKey.SSO_CONFIG,
                    configValue: { enabled: true },
                    fuzzy: true,
                });

            if (!ssoConfigs || ssoConfigs.length === 0) {
                return { ssoEnabled: false };
            }

            const lowercaseDomain = domain.toLowerCase();
            const matchingConfig = ssoConfigs.find((param) => {
                const config = param.configValue as SSOConfig;
                return config?.domains?.some(
                    (d) => d.toLowerCase() === lowercaseDomain,
                );
            });

            if (!matchingConfig) {
                return { ssoEnabled: false };
            }

            const config = matchingConfig.configValue as SSOConfig;
            const redirectUri = config.redirectUris[0]; // Assuming first one for now

            // Construct Google OIDC URL
            const scope = encodeURIComponent('openid email profile');
            const responseType = 'code';
            const clientId = encodeURIComponent(config.clientId);
            const redirect = encodeURIComponent(redirectUri);
            const state = encodeURIComponent(
                JSON.stringify({
                    organizationId: matchingConfig.organization.uuid,
                    provider: 'google',
                }),
            );

            const googleAuthUrl = `${config.issuer}/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirect}&response_type=${responseType}&scope=${scope}&state=${state}&access_type=offline&prompt=consent`;

            return {
                ssoEnabled: true,
                redirectUrl: googleAuthUrl,
                organizationId: matchingConfig.organization.uuid,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error checking SSO status',
                error,
                context: CheckSSOUseCase.name,
                metadata: { email },
            });
            return { ssoEnabled: false };
        }
    }
}

import { createLogger } from '@kodus/flow';
import {
    BadRequestException,
    Injectable,
    InternalServerErrorException,
} from '@nestjs/common';

import {
    SSOProtocol,
    SSOProtocolConfigMap,
} from '../../domain/interfaces/ssoConfig.interface';
import { SSOTestSessionService } from '../../services/sso-test-session.service';
import { buildApiUrl } from '../../utils/api-url.util';

@Injectable()
export class StartSSOConnectionTestUseCase {
    private readonly logger = createLogger(StartSSOConnectionTestUseCase.name);

    constructor(
        private readonly ssoTestSessionService: SSOTestSessionService,
    ) {}

    async execute(params: {
        organizationId: string;
        protocol: SSOProtocol;
        providerConfig: SSOProtocolConfigMap[SSOProtocol];
        domains: string[];
        userId?: string;
    }) {
        const { organizationId, protocol, providerConfig, domains, userId } =
            params;

        if (!organizationId) {
            throw new BadRequestException('Organization not found');
        }

        if (!protocol || !providerConfig || !domains?.length) {
            throw new BadRequestException('Missing required SSO test fields');
        }

        if (protocol === SSOProtocol.SAML) {
            const { entryPoint, cert, idpIssuer } =
                providerConfig as SSOProtocolConfigMap[SSOProtocol.SAML];

            if (!entryPoint || !cert || !idpIssuer) {
                throw new BadRequestException(
                    'entryPoint, cert and idpIssuer are required',
                );
            }
        }

        const session = await this.ssoTestSessionService.createSession({
            organizationId,
            protocol,
            providerConfig,
            domains,
            createdBy: userId,
        });

        let redirectUrl: string;
        try {
            redirectUrl = buildApiUrl(
                `/auth/sso/login/${organizationId}?RelayState=${encodeURIComponent(session.sessionId)}`,
            );
        } catch (err) {
            this.logger.error({
                message:
                    err instanceof Error ? err.message : String(err),
                context: StartSSOConnectionTestUseCase.name,
            });
            throw new InternalServerErrorException('SSO test is unavailable');
        }

        return {
            sessionId: session.sessionId,
            configFingerprint: session.configFingerprint,
            redirectUrl,
        };
    }
}

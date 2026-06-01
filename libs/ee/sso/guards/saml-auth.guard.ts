import { createLogger } from '@kodus/flow';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { SSOTestSessionService } from '../services/sso-test-session.service';
import { mapSSOError } from '../utils/sso-error.util';

@Injectable()
export class SamlAuthGuard extends AuthGuard('saml') implements CanActivate {
    private readonly logger = createLogger(SamlAuthGuard.name);

    constructor(private readonly ssoTestSessionService: SSOTestSessionService) {
        super();
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        try {
            const canActivate = await super.canActivate(context);
            return Boolean(canActivate);
        } catch (error) {
            const request = context.switchToHttp().getRequest();
            const response = context.switchToHttp().getResponse();

            const relayState =
                request?.body?.RelayState || request?.query?.RelayState;

            const mappedError = mapSSOError(error);
            const frontendUrl = process.env.API_FRONTEND_URL;

            this.logger.warn({
                message: 'SAML guard authentication failed',
                context: SamlAuthGuard.name,
                metadata: {
                    organizationId: request?.params?.organizationId,
                    relayState,
                    error: mappedError,
                },
            });

            if (relayState) {
                await this.ssoTestSessionService.markSessionFailed(relayState, {
                    failureCode: mappedError.failureCode,
                    failureMessage: mappedError.message,
                });

                if (frontendUrl) {
                    response.redirect(
                        `${frontendUrl}/organization/sso?ssoTestSessionId=${encodeURIComponent(relayState)}`,
                    );
                    return false;
                }
            }

            if (frontendUrl) {
                const reasonMessage = encodeURIComponent(mappedError.message);
                response.redirect(
                    `${frontendUrl}/sign-in?reason=${mappedError.reasonCode}&reasonMessage=${reasonMessage}`,
                );
                return false;
            }

            throw error;
        }
    }
}

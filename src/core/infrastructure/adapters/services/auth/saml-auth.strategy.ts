import {
    ISSOConfigService,
    SSO_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/auth/contracts/ssoConfig.service.contract';
import { SSOProtocol } from '@/core/domain/auth/interfaces/ssoConfig.interface';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { MultiSamlStrategy } from 'passport-saml';

@Injectable()
export class SamlStrategy extends PassportStrategy(MultiSamlStrategy, 'saml') {
    constructor(
        @Inject(SSO_CONFIG_SERVICE_TOKEN)
        private readonly ssoConfigService: ISSOConfigService,
    ) {
        super({
            passReqToCallback: true,
            getSamlOptions: async (req, done) => {
                try {
                    const organizationId = req.params.organizationId;

                    if (!organizationId) {
                        return done(new Error('No Organization ID provided'));
                    }

                    const ssoConfig = await this.ssoConfigService.findOne({
                        protocol: SSOProtocol.SAML,
                        organization: {
                            uuid: organizationId,
                        },
                    });

                    if (!ssoConfig) {
                        return done(new Error('SSO config not found'));
                    }

                    return done(null, {
                        entryPoint: ssoConfig.providerConfig.entryPoint,
                        cert: ssoConfig.providerConfig.cert,
                        idpIssuer: ssoConfig.providerConfig.idpIssuer,
                        issuer:
                            ssoConfig.providerConfig.issuer ||
                            'kodus-orchestrator',
                        callbackUrl: `${process.env.API_URL}/auth/sso/saml/callback/${organizationId}`,
                        wantAssertionsSigned: false,
                        identifierFormat:
                            ssoConfig.providerConfig.identifierFormat || null,
                    });
                } catch (error) {
                    return done(error, null);
                }
            },
        });
    }

    async validate(req: Request, profile: any) {
        const email: string = profile.email || profile.nameId || profile.nameID;

        if (!email || !/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,3}/.test(email)) {
            throw new UnauthorizedException('Invalid email in SAML assertion');
        }

        return {
            email,
            firstName: profile.firstName || '',
            lastName: profile.lastName || '',
            organizationId: req.params.organizationId,
        };
    }
}

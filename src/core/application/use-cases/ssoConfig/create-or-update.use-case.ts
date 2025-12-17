import {
    ISSOConfigService,
    SSO_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/auth/contracts/ssoConfig.service.contract';
import {
    SSOProtocol,
    SSOProtocolConfigMap,
} from '@/core/domain/auth/interfaces/ssoConfig.interface';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class CreateOrUpdateSSOConfigUseCase {
    constructor(
        @Inject(SSO_CONFIG_SERVICE_TOKEN)
        private readonly ssoConfigService: ISSOConfigService,
        private readonly logger: PinoLoggerService,
    ) {}

    async execute(params: {
        organizationId: string;
        uuid?: string;
        protocol?: SSOProtocol;
        providerConfig?: SSOProtocolConfigMap[SSOProtocol];
        active?: boolean;
        domains?: string[];
    }) {
        const {
            organizationId,
            uuid,
            protocol,
            providerConfig,
            active,
            domains,
        } = params;

        if (uuid) {
            const ssoConfig = await this.ssoConfigService.findOne({
                uuid,
                organization: {
                    uuid: organizationId,
                },
            });

            if (!ssoConfig) {
                this.logger.error({
                    message: 'SSOConfig not found',
                    context: CreateOrUpdateSSOConfigUseCase.name,
                    metadata: { uuid, organizationId },
                });
                throw new Error('SSOConfig not found');
            }

            const updated = await this.ssoConfigService.update(ssoConfig.uuid, {
                protocol,
                providerConfig,
                active,
                domains,
            });

            this.logger.log({
                message: 'SSO config updated successfully',
                context: CreateOrUpdateSSOConfigUseCase.name,
                metadata: { uuid: updated.uuid, organizationId },
            });

            return updated.toJson();
        }

        if (!protocol || !providerConfig || !domains) {
            this.logger.error({
                message: 'Missing required fields for SSO config creation',
                context: CreateOrUpdateSSOConfigUseCase.name,
                metadata: { protocol, providerConfig, domains },
            });
            throw new Error('Missing required fields');
        }

        const created = await this.ssoConfigService.create({
            protocol,
            providerConfig,
            active,
            organization: {
                uuid: organizationId,
            },
            domains,
        });

        this.logger.log({
            message: 'SSO config created successfully',
            context: CreateOrUpdateSSOConfigUseCase.name,
            metadata: { uuid: created.uuid, organizationId },
        });

        return created.toJson();
    }
}

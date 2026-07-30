import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { createLogger } from '@libs/core/log/logger';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import { IOrganization } from '@libs/organization/domain/organization/interfaces/organization.interface';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersAutoJoinConfig } from '@libs/organization/domain/organizationParameters/types/organizationParameters.types';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class GetOrganizationsByDomainUseCase implements IUseCase {
    private readonly logger = createLogger(
        GetOrganizationsByDomainUseCase.name,
    );
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    public async execute(domain: string): Promise<Partial<IOrganization>[]> {
        try {
            if (!domain) {
                this.logger.warn({
                    message: 'Domain is required to fetch organizations',
                    context: GetOrganizationsByDomainUseCase.name,
                });
                return [];
            }

            const autoJoinOrgs =
                await this.organizationParametersService.findByKeyAndValue({
                    configKey: OrganizationParametersKey.AUTO_JOIN_CONFIG,
                    configValue: { enabled: true },
                    fuzzy: true,
                });

            if (!autoJoinOrgs || autoJoinOrgs.length === 0) {
                this.logger.warn({
                    message: 'No organizations found with auto-join enabled',
                    context: GetOrganizationsByDomainUseCase.name,
                    metadata: { domain },
                    serviceName: GetOrganizationsByDomainUseCase.name,
                });
                return [];
            }

            const lowercaseDomain = domain.toLowerCase();
            const matchingDomains = autoJoinOrgs.filter((org) => {
                const config =
                    org.configValue as OrganizationParametersAutoJoinConfig;
                return config?.domains?.some(
                    (d) => d.toLowerCase() === lowercaseDomain,
                );
            });

            if (!matchingDomains || matchingDomains.length === 0) {
                this.logger.warn({
                    message: 'No organizations match the provided domain',
                    context: GetOrganizationsByDomainUseCase.name,
                    metadata: { domain },
                    serviceName: GetOrganizationsByDomainUseCase.name,
                });
                return [];
            }

            const organizationUuids = matchingDomains.map(
                (org) => org.organization.uuid,
            );

            const organizationsPromises = organizationUuids.map(
                async (uuid) =>
                    await this.organizationService.findOne({ uuid }),
            );

            const organizations = (
                await Promise.all(organizationsPromises)
            ).filter(Boolean);

            if (!organizations || organizations.length === 0) {
                this.logger.warn({
                    message: 'No organizations found for the provided domain',
                    context: GetOrganizationsByDomainUseCase.name,
                    metadata: { domain },
                    serviceName: GetOrganizationsByDomainUseCase.name,
                });
                return [];
            }

            this.logger.debug({
                message: 'Organizations fetched successfully by domain',
                context: GetOrganizationsByDomainUseCase.name,
                metadata: { domain, count: organizations.length },
                serviceName: GetOrganizationsByDomainUseCase.name,
            });

            return organizations.map((org) => ({
                uuid: org.uuid,
                name: org.name,
                owner: org.user.find((u) => u.role === Role.OWNER)?.email,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error fetching organizations by domain',
                error,
                context: GetOrganizationsByDomainUseCase.name,
                metadata: { domain },
                serviceName: GetOrganizationsByDomainUseCase.name,
            });
            throw error;
        }
    }
}

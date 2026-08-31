import { IOrganizationParametersRepository } from './organizationParameters.repository.contract';
import { OrganizationParametersEntity } from '../entities/organizationParameters.entity';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export const ORGANIZATION_PARAMETERS_SERVICE_TOKEN = Symbol(
    'OrganizationParametersService',
);

export interface IOrganizationParametersService extends IOrganizationParametersRepository {
    createOrUpdateConfig(
        organizationParametersKey: OrganizationParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity | boolean>;
    findByKey(
        configKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity>;
    rotateCodexTokens(input: {
        credentialId: string;
        organizationId: string;
        expectedRefreshToken: string;
        accessToken: string;
        refreshToken: string;
        accountId: string;
    }): Promise<{
        accessToken: string;
        refreshToken: string;
        accountId: string;
    }>;
    deleteByokConfig(
        organizationId: string,
        configType: 'main' | 'fallback',
    ): Promise<boolean>;
    /**
     * v2 delete-by-model-id (REQ-DELETE-01). Removes the `models[]` entry with
     * `modelId`, drops any now-orphan non-managed credential, and performs the
     * explicit last-model disconnect (removes the whole BYOK config) rather than
     * leaving an empty pool. The referential-integrity guard runs in the
     * use-case; this receives an already-validated model id. Retained ciphertext
     * is written back verbatim (never re-encrypted).
     */
    deleteByokModel(organizationId: string, modelId: string): Promise<boolean>;
}

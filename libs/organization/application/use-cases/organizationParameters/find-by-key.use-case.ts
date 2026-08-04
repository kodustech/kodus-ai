import { decrypt } from '@libs/common/utils/crypto';
import {
    isByokConfig,
    type BYOKConfig,
    type BYOKCredential,
} from '@libs/llm/byok-config';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import { IOrganizationParameters } from '@libs/organization/domain/organizationParameters/interfaces/organizationParameters.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class FindByKeyOrganizationParametersUseCase implements IUseCase {
    private readonly logger = createLogger(
        FindByKeyOrganizationParametersUseCase.name,
    );
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(
        organizationParametersKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IOrganizationParameters | null> {
        try {
            const parameter =
                await this.organizationParametersService.findByKey(
                    organizationParametersKey,
                    organizationAndTeamData,
                );

            if (!parameter) {
                return null;
            }

            // Process BYOK configuration by masking sensitive credential
            // fields (apiKey for non-Bedrock providers, awsBearerToken /
            // awsAccessKeyId / awsSecretAccessKey / awsSessionToken for
            // Bedrock). Bedrock configs have no apiKey, so the gating
            // check has to consider the AWS fields as well.
            if (
                organizationParametersKey ===
                OrganizationParametersKey.BYOK_CONFIG
            ) {
                const configValue = parameter.configValue;

                // v2-only (04b-06 — the legacy main/fallback mask is GONE):
                // secrets live per-credential (credentials[].apiKey + aws* under
                // settings). Mask them before the blob leaves the server
                // (T-04b-06-01), leaving models[]/routing plaintext. A non-config blob
                // carries only ciphertext (never plaintext) and passes through
                // unmasked — it is on its way out via the 04b-07 migration.
                if (isByokConfig(configValue)) {
                    try {
                        const processedConfig =
                            this.maskV2ConfigSecrets(configValue);

                        return {
                            uuid: parameter.uuid,
                            configKey: parameter.configKey,
                            configValue: processedConfig,
                            organization: parameter.organization,
                        };
                    } catch (error) {
                        this.logger.error({
                            message: 'Error masking v2 BYOK credentials',
                            context:
                                FindByKeyOrganizationParametersUseCase.name,
                            error: error,
                        });
                        // Return original value in case of decryption error
                        return this.getUpdatedParameters(parameter);
                    }
                }
            }

            const updatedParameters = this.getUpdatedParameters(parameter);

            return updatedParameters;
        } catch (error) {
            this.logger.error({
                message: 'Error finding organization parameters by key',
                context: FindByKeyOrganizationParametersUseCase.name,
                error: error,
                metadata: {
                    organizationParametersKey,
                    organizationAndTeamData,
                },
            });

            throw error;
        }
    }

    private getUpdatedParameters(parameter: OrganizationParametersEntity) {
        return {
            uuid: parameter.uuid,
            configKey: parameter.configKey,
            configValue: parameter.configValue,
            organization: parameter.organization,
        };
    }

    /** Placeholder for a masked/unreadable secret — never echoes plaintext. */
    private static readonly MASK_PLACEHOLDER = '••••';

    private maskApiKey(apiKey: string): string {
        // A short/garbage decrypted value must be masked too — echoing it in
        // full would leak the plaintext key (S3). The `••••` placeholder never
        // appears in a real key, so a round-tripped write is safely detected as
        // "unchanged" by create-or-update's isMaskedSecret.
        if (apiKey.length <= 6) {
            return FindByKeyOrganizationParametersUseCase.MASK_PLACEHOLDER;
        }
        const firstTwo = apiKey.substring(0, 2);
        const lastThree = apiKey.substring(apiKey.length - 3);
        return `${firstTwo}...${lastThree}`;
    }

    /**
     * Decrypt + mask a single secret field, degrading to a placeholder when the
     * ciphertext is undecryptable. One unreadable credential must NEVER abort
     * the whole mask and fall through to returning RAW ciphertext to the caller
     * (S2 — fail closed, not open).
     */
    private safeMaskSecret(cipher: string): string {
        try {
            return this.maskApiKey(decrypt(cipher));
        } catch {
            return FindByKeyOrganizationParametersUseCase.MASK_PLACEHOLDER;
        }
    }

    /**
     * The encrypted secret fields carried inside a credential's `settings`
     * (Amazon Bedrock auth). Kept in sync with `V2_SECRET_SETTINGS` in
     * create-or-update.use-case.ts. `awsRegion`, `baseURL`, `vertexLocation`
     * are plaintext settings and are left untouched.
     */
    private static readonly V2_SECRET_SETTINGS = [
        'awsBearerToken',
        'awsAccessKeyId',
        'awsSecretAccessKey',
        'awsSessionToken',
    ] as const;

    /**
     * Mask every credential's secret fields on a config: the top-level
     * `apiKey` and the aws* fields under `settings`. `models[]`/`routing`/
     * `version` pass through plaintext. A managed credential (env default,
     * hidden from the UI) never surfaces a secret — its secret fields are
     * stripped entirely rather than masked.
     */
    private maskV2ConfigSecrets(config: BYOKConfig): BYOKConfig {
        const credentials = (config.credentials ?? []).map((cred) =>
            this.maskCredentialSecrets(cred),
        );
        return { ...config, credentials };
    }

    private maskCredentialSecrets(cred: BYOKCredential): BYOKCredential {
        const masked: BYOKCredential = { ...cred };

        // A managed credential must never expose a secret; drop any that exist.
        if (cred.managed) {
            delete masked.apiKey;
            if (cred.settings && typeof cred.settings === 'object') {
                const settings: Record<string, unknown> = { ...cred.settings };
                for (const field of FindByKeyOrganizationParametersUseCase.V2_SECRET_SETTINGS) {
                    delete settings[field];
                }
                masked.settings = settings;
            }
            return masked;
        }

        if (typeof cred.apiKey === 'string' && cred.apiKey) {
            masked.apiKey = this.safeMaskSecret(cred.apiKey);
        }

        if (cred.settings && typeof cred.settings === 'object') {
            const settings: Record<string, unknown> = { ...cred.settings };
            for (const field of FindByKeyOrganizationParametersUseCase.V2_SECRET_SETTINGS) {
                const value = settings[field];
                if (typeof value === 'string' && value) {
                    settings[field] = this.safeMaskSecret(value);
                }
            }
            masked.settings = settings;
        }

        return masked;
    }
}

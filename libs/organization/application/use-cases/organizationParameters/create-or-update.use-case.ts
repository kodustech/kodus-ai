import type { BYOKConfig } from '@libs/llm/byok-config';
import { encrypt } from '@libs/common/utils/crypto';
import {
    isV2Config,
    type BYOKConfigV2,
    type BYOKCredential,
} from '@libs/llm/byok-config';
import { validateByokConfigRefs } from '@libs/llm/validate-byok-config-refs';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import {
    BadRequestException,
    HttpException,
    Inject,
    Injectable,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

const AUDITABLE_KEYS = new Set([
    OrganizationParametersKey.AUTO_JOIN_CONFIG,
    OrganizationParametersKey.TIMEZONE_CONFIG,
    OrganizationParametersKey.COCKPIT_METRICS_VISIBILITY,
]);

@Injectable()
export class CreateOrUpdateOrganizationParametersUseCase implements IUseCase {
    private readonly logger = createLogger(
        CreateOrUpdateOrganizationParametersUseCase.name,
    );
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly eventEmitter: EventEmitter2,
        private readonly telemetry: TelemetryService,
    ) {}

    async execute(
        organizationParametersKey: OrganizationParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity | boolean> {
        try {
            const processedConfigValue = configValue;
            if (
                organizationParametersKey ===
                OrganizationParametersKey.BYOK_CONFIG
            ) {
                return await this.saveByokConfig(
                    organizationParametersKey,
                    configValue,
                    organizationAndTeamData,
                );
            }

            let previousValue: any = null;
            if (AUDITABLE_KEYS.has(organizationParametersKey)) {
                const existing =
                    await this.organizationParametersService.findByKey(
                        organizationParametersKey,
                        organizationAndTeamData,
                    );
                previousValue = existing?.configValue ?? null;
            }

            const result =
                await this.organizationParametersService.createOrUpdateConfig(
                    organizationParametersKey,
                    processedConfigValue,
                    organizationAndTeamData,
                );

            if (AUDITABLE_KEYS.has(organizationParametersKey)) {
                this.eventEmitter.emit(AuditLogEvents.ORG_SETTINGS, {
                    organizationAndTeamData,
                    userInfo: {
                        userId: this.request.user?.uuid,
                        userEmail: this.request.user?.email,
                    },
                    actionType: ActionType.EDIT,
                    settingKey: organizationParametersKey,
                    previousValue,
                    currentValue: processedConfigValue,
                });
            }

            return result;
        } catch (error) {
            // Preserve mapped HTTP errors (e.g. the 4xx BadRequestException the
            // v2 referential-integrity gate throws) — wrapping them in a generic
            // Error would collapse them to a 500 and drop the collected messages.
            if (error instanceof HttpException) {
                throw error;
            }

            this.logger.error({
                message: 'Error creating or updating organization parameters',
                context: CreateOrUpdateOrganizationParametersUseCase.name,
                error: error,
                metadata: {
                    organizationParametersKey,
                    // NEVER log the raw configValue: for BYOK it is the client's
                    // credential blob (apiKey / aws* secrets). Defense-in-depth on
                    // top of the logger's key redaction — the raw blob must not
                    // reach the log path at all.
                    organizationAndTeamData,
                },
            });
            throw new Error(
                'Error creating or updating organization parameters',
                { cause: error },
            );
        }
    }

    private async saveByokConfig(
        organizationParametersKey: OrganizationParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean> {
        // Write-time referential integrity for the untyped v2 blob (RFC §13.8):
        // the DTO is `configValue: any`, so this is the ONLY server-side schema
        // gate. Reject a dangling model.credentialId / routing ref BEFORE persist
        // (never silently drop). Legacy configs are a no-op pass.
        if (isV2Config(configValue)) {
            const refCheck = validateByokConfigRefs(configValue);
            if (!refCheck.valid) {
                throw new BadRequestException({
                    message:
                        'Invalid BYOK configuration: unresolved model/routing references',
                    errors: refCheck.errors,
                });
            }
        }

        const getConfigValue =
            await this.organizationParametersService.findByKey(
                organizationParametersKey,
                organizationAndTeamData,
            );

        const existingConfig = getConfigValue?.configValue as
            | BYOKConfig
            | BYOKConfigV2
            | undefined;

        const processedConfigValue = this.encryptByokConfigApiKey(
            configValue,
            existingConfig,
        );

        // The front-end fully drives the untyped v2 blob, so a v2 write is the
        // complete intended config — use it verbatim (04b-06: encrypt now rejects
        // any non-v2 shape, so there is no legacy partial-save merge to preserve).
        const mergedConfigValue = processedConfigValue;

        const result =
            await this.organizationParametersService.createOrUpdateConfig(
                organizationParametersKey,
                mergedConfigValue,
                organizationAndTeamData,
            );

        this.eventEmitter.emit(AuditLogEvents.ORG_SETTINGS, {
            organizationAndTeamData,
            userInfo: {
                userId: this.request.user?.uuid,
                userEmail: this.request.user?.email,
            },
            actionType: ActionType.EDIT,
            settingKey: organizationParametersKey,
            previousValue: existingConfig ?? null,
            currentValue: mergedConfigValue,
        });

        if (result && this.request.user?.uuid) {
            const telemetryMeta =
                this.describeByokForTelemetry(mergedConfigValue);
            void this.telemetry.byokConfigured({
                userId: this.request.user.uuid,
                organizationId: organizationAndTeamData.organizationId,
                provider: telemetryMeta.provider,
                slot: telemetryMeta.slot,
            });
        }

        return !!result;
    }

    private encryptByokConfigApiKey(
        configValue: any,
        existingConfig?: BYOKConfig | BYOKConfigV2,
    ): BYOKConfigV2 {
        if (!configValue || typeof configValue !== 'object') {
            throw new Error('Invalid BYOK config value');
        }

        // v2-only (04b-06 — the legacy {main,fallback} encrypt path is GONE).
        // Secrets live per-credential (credentials[].apiKey + aws* in settings),
        // NOT in top-level main/fallback. Resolve the prior ciphertext to keep
        // from the matching credentials[] entry (by id, else provider) so a
        // migrated org does not lose its key on a blank/masked resubmit. A non-v2
        // blob is rejected: v2 is the only accepted stored shape.
        if (!isV2Config(configValue)) {
            throw new Error('Invalid BYOK config value: expected v2 shape');
        }
        return this.encryptV2ByokConfig(
            configValue,
            isV2Config(existingConfig) ? existingConfig : undefined,
        );
    }

    /**
     * v2 encrypt/keep. For each incoming credential, encrypt/keep its secret
     * fields against the matching prior credential (matched by `id`, else by
     * `provider`): a blank/empty field keeps the prior ciphertext, a real value
     * is encrypt()'d, and the `••••` mask is NEVER encrypted (encryptOrKeep).
     * models[] / routing / version pass through untouched — field-level encrypt
     * only, no re-encryption of untouched ciphertext.
     */
    private encryptV2ByokConfig(
        next: BYOKConfigV2,
        existing?: BYOKConfigV2,
    ): BYOKConfigV2 {
        const existingById = new Map<string, BYOKCredential>();
        const existingByProvider = new Map<string, BYOKCredential>();
        for (const cred of existing?.credentials ?? []) {
            if (!cred) continue;
            if (cred.id) existingById.set(cred.id, cred);
            if (cred.provider && !existingByProvider.has(cred.provider)) {
                existingByProvider.set(cred.provider, cred);
            }
        }

        const credentials = (next.credentials ?? []).map((cred) => {
            const prior =
                (cred.id ? existingById.get(cred.id) : undefined) ??
                (cred.provider
                    ? existingByProvider.get(cred.provider)
                    : undefined);
            return this.encryptCredentialSecrets(cred, prior);
        });

        return {
            ...next,
            credentials,
        };
    }

    /**
     * Encrypt/keep the secret fields of a single v2 credential. `apiKey` lives at
     * the top level; the Bedrock aws* secrets live under `settings`. Each field
     * follows the same encryptOrKeep contract (keep on EMPTY, never encrypt the
     * mask). Non-secret settings (baseURL, vertexLocation, awsRegion, …) pass
     * through verbatim. A managed credential (no key) stays keyless.
     */
    private encryptCredentialSecrets(
        next: BYOKCredential,
        existing?: BYOKCredential,
    ): BYOKCredential {
        const result: BYOKCredential = { ...next };

        const apiKey = this.encryptOrKeep(next.apiKey, existing?.apiKey);
        if (apiKey !== undefined) {
            result.apiKey = apiKey;
        } else {
            delete result.apiKey;
        }

        const nextSettings = next.settings;
        const existingSettings = existing?.settings;
        if (nextSettings || existingSettings) {
            const settings: Record<string, unknown> = { ...(nextSettings ?? {}) };
            for (const field of CreateOrUpdateOrganizationParametersUseCase.V2_SECRET_SETTINGS) {
                const kept = this.encryptOrKeep(
                    typeof nextSettings?.[field] === 'string'
                        ? (nextSettings[field] as string)
                        : undefined,
                    typeof existingSettings?.[field] === 'string'
                        ? (existingSettings[field] as string)
                        : undefined,
                );
                if (kept !== undefined) {
                    settings[field] = kept;
                } else {
                    delete settings[field];
                }
            }
            result.settings = settings;
        }

        return result;
    }

    /** Secret fields carried inside a v2 credential's `settings` (Bedrock auth). */
    private static readonly V2_SECRET_SETTINGS = [
        'awsBearerToken',
        'awsAccessKeyId',
        'awsSecretAccessKey',
        'awsSessionToken',
    ] as const;

    /**
     * Provider + slot for the byok_configured telemetry event. v2-only (04b-06 —
     * the legacy main/fallback read is GONE): the "main" is the routing default
     * model's credential (else the first model's). A non-v2 blob reports no
     * provider (it is rejected upstream at encrypt time).
     */
    private describeByokForTelemetry(config: BYOKConfig | BYOKConfigV2): {
        provider?: string;
        slot: 'main' | 'fallback';
    } {
        if (isV2Config(config)) {
            const models = config.models ?? [];
            const creds = new Map(
                (config.credentials ?? [])
                    .filter((c) => c && c.id)
                    .map((c) => [c.id, c]),
            );
            const mainModel =
                (config.routing?.defaultModelId &&
                    models.find(
                        (m) => m?.id === config.routing?.defaultModelId,
                    )) ||
                models[0];
            const provider = mainModel
                ? creds.get(mainModel.credentialId)?.provider
                : undefined;
            return { provider, slot: 'main' };
        }
        return { provider: undefined, slot: 'main' };
    }

    private encryptOrKeep(
        incoming: string | undefined,
        existing: string | undefined,
    ): string | undefined {
        const trimmed = incoming?.trim();
        // Keep the existing ciphertext on an EMPTY field (the front sends blank
        // for an unchanged key) OR when the incoming value is the `••••` display
        // mask echoed back — the mask must NEVER be encrypted as a real key
        // (RESEARCH Pitfall 3 / T-04-03-01). Only a real non-empty value
        // replaces the ciphertext.
        if (!trimmed || this.isMaskedSecret(trimmed)) return existing;
        return encrypt(trimmed);
    }

    /**
     * A masked secret echoed back by a client must NEVER be encrypted as if it
     * were a real key — doing so silently destroys the stored credential. Two
     * mask shapes exist:
     *  - the client UI mask: a run of U+2022 bullets (`••••`);
     *  - the SERVER display mask emitted by find-by-key's maskApiKey:
     *    `firstTwo...lastThree` (two chars + three dots + three chars, e.g.
     *    `sk...def`) — a round-tripped read must be treated as "unchanged".
     * Neither shape appears in a real provider key.
     */
    private isMaskedSecret(value: string): boolean {
        if (value.includes('•')) return true;
        // Server dotted mask: exactly first2 + '...' + last3 (see maskApiKey).
        return /^.{2}\.{3}.{3}$/.test(value);
    }
}

import { encrypt } from '@libs/common/utils/crypto';
import {
    isByokConfig,
    BYOK_SECRET_SETTINGS,
    type BYOKConfig,
    type BYOKCredential,
} from '@libs/llm/byok-config';
import { validateByokConfigRefs } from '@libs/llm/validate-byok-config-refs';
import { BYOKProvider } from '@libs/llm/model-providers';
import { assertSafeOpenAICompatibleUrl } from './test-byok-connection.use-case';
import { describeProtocolMismatch } from '@libs/llm/base-url-hygiene';
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
        // Write-time referential integrity for the untyped config blob (RFC §13.8):
        // the DTO is `configValue: any`, so this is the ONLY server-side schema
        // gate. Reject a dangling model.credentialId / routing ref BEFORE persist
        // (never silently drop). Legacy configs are a no-op pass.
        if (isByokConfig(configValue)) {
            const refCheck = validateByokConfigRefs(configValue);
            if (!refCheck.valid) {
                throw new BadRequestException({
                    message:
                        'Invalid BYOK configuration: unresolved model/routing references',
                    errors: refCheck.errors,
                });
            }

            this.assertParsableReasoningOverrides(configValue);
        }

        const getConfigValue =
            await this.organizationParametersService.findByKey(
                organizationParametersKey,
                organizationAndTeamData,
            );

        const existingConfig = getConfigValue?.configValue as
            BYOKConfig | undefined;

        if (isByokConfig(configValue)) {
            // SSRF guard: a credential's baseURL is user-controlled and the
            // server makes outbound LLM calls to it at review time. The
            // test-connection probe validates it, but a save can set/change it
            // WITHOUT probing (or via a direct API call), so the runtime target
            // would otherwise never be checked.
            //
            // Runs AFTER the existing config is loaded so it can validate only
            // what CHANGED. Validating every stored credential on every write
            // meant an org whose baseURL predates this rule (a real one still
            // points at http://localhost:11434) could no longer save ANY BYOK
            // change at all — not even switching model — because an untouched
            // field failed a rule it was saved before. An unchanged value is
            // already-persisted state, not a new outbound target; a changed or
            // new one is still validated in full, so nothing can slip in.
            await this.assertSafeByokBaseURLs(
                configValue,
                isByokConfig(existingConfig) ? existingConfig : undefined,
            );
        }

        const processedConfigValue = this.encryptByokConfigApiKey(
            configValue,
            existingConfig,
        );

        // The front-end fully drives the untyped config blob, so a write is the
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

    /**
     * SSRF guard for the SAVE path: validate each NEW or CHANGED credential's
     * user-provided `settings.baseURL` the same way the test-connection probe
     * does (https + publicly-resolvable host, no private/reserved IP, and no
     * endpoint path baked into the base). Only openai/anthropic-compatible
     * credentials carry a baseURL; providers that hardcode their endpoint
     * (vertex, bedrock) have none and are skipped. An empty baseURL (a key-only
     * connect that resolves the brand's curated default at runtime) has nothing
     * to check.
     *
     * A value identical to the stored one is skipped ON PURPOSE. It cannot be
     * used to introduce anything: the only value that skips is one already
     * persisted, so the escape hatch admits no new outbound target — it only
     * stops a legacy value from bricking every future write for that org.
     */
    private async assertSafeByokBaseURLs(
        config: BYOKConfig,
        existing?: BYOKConfig,
    ): Promise<void> {
        const previous = new Map<string, string>();
        for (const cred of existing?.credentials ?? []) {
            const url = cred?.settings?.baseURL;
            if (typeof url === 'string' && url.trim()) {
                // Keyed by credential id when there is one, else by provider —
                // the same matching `encryptV2ByokConfig` uses to carry a kept
                // secret forward, so "unchanged" means the same thing in both.
                previous.set(
                    String(cred?.id ?? cred?.provider ?? ''),
                    url.trim(),
                );
            }
        }

        for (const cred of config.credentials ?? []) {
            const baseURL = cred?.settings?.baseURL;
            if (typeof baseURL !== 'string' || !baseURL.trim()) continue;
            const key = String(cred?.id ?? cred?.provider ?? '');
            if (previous.get(key) === baseURL.trim()) continue; // untouched
            // A base URL naming the wrong PROTOCOL for its provider is valid on
            // its own and dead in combination — one production slot stores
            // `.../anthropic` under `openai_compatible` and dials a route that
            // exists nowhere. Rejected rather than repaired: the correct URL is
            // not derivable, since the user meant either a different provider or
            // a different path.
            const mismatch = describeProtocolMismatch(
                String(cred?.provider ?? ''),
                baseURL.trim(),
            );
            if (mismatch) {
                throw new BadRequestException({
                    message: 'Invalid BYOK configuration: base URL mismatch',
                    errors: [mismatch],
                });
            }
            await assertSafeOpenAICompatibleUrl(baseURL.trim());
        }
    }

    /**
     * A per-model `reasoningConfigOverride` is free-form JSON the user pastes in
     * the Advanced panel. `buildProviderOptions` parses it inside a try/catch and
     * FALLS BACK to the effort preset when it doesn't parse — which is the right
     * runtime posture (a typo must not break every review) but makes a typo
     * invisible: two production orgs are running with a trailing comma in theirs,
     * convinced they enabled `reasoning_effort: max`, and have never been told.
     *
     * Save time is where the user is looking, so reject it here.
     */
    private assertParsableReasoningOverrides(config: BYOKConfig): void {
        const errors: string[] = [];
        for (const model of config.models ?? []) {
            const override = (model as any)?.reasoningConfigOverride;
            if (typeof override !== 'string' || !override.trim()) continue;
            try {
                const parsed = JSON.parse(override);
                if (
                    !parsed ||
                    typeof parsed !== 'object' ||
                    Array.isArray(parsed)
                ) {
                    errors.push(
                        `Model "${(model as any)?.model ?? (model as any)?.id}": the reasoning override must be a JSON object.`,
                    );
                }
            } catch (err) {
                errors.push(
                    `Model "${(model as any)?.model ?? (model as any)?.id}": the reasoning override is not valid JSON (${(err as Error).message}).`,
                );
            }
        }
        if (errors.length) {
            throw new BadRequestException({
                message:
                    'Invalid BYOK configuration: unparsable reasoning override',
                errors,
            });
        }
    }

    private encryptByokConfigApiKey(
        configValue: any,
        existingConfig?: BYOKConfig,
    ): BYOKConfig {
        if (!configValue || typeof configValue !== 'object') {
            throw new Error('Invalid BYOK config value');
        }

        // v2-only (04b-06 — the legacy {main,fallback} encrypt path is GONE).
        // Secrets live per-credential (credentials[].apiKey + aws* in settings),
        // NOT in top-level main/fallback. Resolve the prior ciphertext to keep
        // from the matching credentials[] entry (by id, else provider) so a
        // migrated org does not lose its key on a blank/masked resubmit. A non-v2
        // blob is rejected: v2 is the only accepted stored shape.
        if (!isByokConfig(configValue)) {
            throw new Error('Invalid BYOK config value: expected v2 shape');
        }
        return this.encryptV2ByokConfig(
            configValue,
            isByokConfig(existingConfig) ? existingConfig : undefined,
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
        next: BYOKConfig,
        existing?: BYOKConfig,
    ): BYOKConfig {
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
            // A managed credential carries NO secret of its own — the runtime
            // resolves the Kodus-funded key from env. Skip the encrypt/keep +
            // auth pass entirely: the provider-based `prior` fallback below would
            // otherwise hand it a NON-managed credential's ciphertext, storing a
            // contradictory `managed: true` + stale key. Force apiKey undefined.
            if (cred?.managed) {
                // Defense-in-depth: this path skips encryptCredentialSecrets, so
                // strip any BYOK_SECRET_SETTINGS (aws*) a caller may have attached
                // — otherwise a plaintext secret would be persisted unencrypted on
                // a credential that is supposed to carry none. Non-secret settings
                // (baseURL, vertexLocation) are preserved.
                const managed = { ...cred, apiKey: undefined };
                if (managed.settings && typeof managed.settings === 'object') {
                    const cleaned = {
                        ...(managed.settings as Record<string, unknown>),
                    };
                    for (const field of BYOK_SECRET_SETTINGS) {
                        delete cleaned[field];
                    }
                    managed.settings = cleaned;
                }
                return managed;
            }
            const prior =
                (cred.id ? existingById.get(cred.id) : undefined) ??
                (cred.provider
                    ? existingByProvider.get(cred.provider)
                    : undefined);
            const encrypted = this.encryptCredentialSecrets(cred, prior);
            // Auth-path integrity: after encrypt/keep, a non-managed credential
            // must carry a usable secret (a kept ciphertext counts). Bedrock
            // accepts a bearer token OR IAM (access key + secret); every other
            // provider requires an apiKey. Guards against persisting a keyless
            // BYOK credential the runtime can't use.
            this.validateCredentialAuth(encrypted);
            return encrypted;
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
            const settings: Record<string, unknown> = {
                ...(nextSettings ?? {}),
            };
            for (const field of BYOK_SECRET_SETTINGS) {
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

    /**
     * Reject a non-managed credential that carries no usable secret after the
     * encrypt/keep pass. Bedrock is satisfied by a bearer token OR IAM (access
     * key id + secret access key); every other provider needs an `apiKey`. A
     * kept ciphertext (partial edit) counts as present, so this only fires on a
     * genuinely keyless save. Managed credentials use platform keys and skip.
     */
    private validateCredentialAuth(cred: BYOKCredential): void {
        if (cred?.managed) {
            return;
        }
        const has = (v: unknown): boolean =>
            typeof v === 'string' && v.length > 0;
        const settings = (cred?.settings ?? {}) as Record<string, unknown>;

        if (cred?.provider === BYOKProvider.AMAZON_BEDROCK) {
            const hasBearer = has(settings.awsBearerToken);
            const hasIam =
                has(settings.awsAccessKeyId) &&
                has(settings.awsSecretAccessKey);
            if (!hasBearer && !hasIam) {
                throw new BadRequestException(
                    'Bedrock BYOK credential requires either awsBearerToken or awsAccessKeyId + awsSecretAccessKey',
                );
            }
            return;
        }

        if (!has(cred?.apiKey)) {
            throw new BadRequestException(
                `apiKey is required for the ${cred?.provider ?? 'unknown'} BYOK credential`,
            );
        }
    }

    /**
     * Provider + slot for the byok_configured telemetry event. v2-only (04b-06 —
     * the legacy main/fallback read is GONE): the "main" is the routing default
     * model's credential (else the first model's). A non-config blob reports no
     * provider (it is rejected upstream at encrypt time).
     */
    private describeByokForTelemetry(config: BYOKConfig): {
        provider?: string;
        slot: 'main' | 'fallback';
    } {
        if (isByokConfig(config)) {
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

import { decrypt } from '@libs/common/utils/crypto';
import { isByokConfig } from '@libs/llm/byok-config';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IOrganizationParametersService } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';

/**
 * A BYOK credential slot with its sensitive fields decrypted, ready to hand to
 * a server-side provider probe (model listing / connection test). NEVER return
 * this to a client — the whole point is to keep the plaintext key server-side.
 */
export interface DecryptedByokSlot {
    provider: string;
    apiKey?: string;
    baseURL?: string;
    model?: string;
    vertexLocation?: string;
    awsBearerToken?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsRegion?: string;
    awsSessionToken?: string;
    codexAccessToken?: string;
    codexRefreshToken?: string;
    accountId?: string;
}

/** decrypt() but tolerant of already-plaintext / undecryptable values. */
function safeDecrypt(value?: string): string | undefined {
    if (!value) return undefined;
    try {
        return decrypt(value);
    } catch {
        // Preserve an already-plaintext value; a corrupted-ciphertext value
        // will still fail downstream (auth error) rather than being dropped.
        return value;
    }
}

/**
 * Resolve the org's OWN stored credentials for `provider`, decrypting the
 * sensitive fields. v2-only (04b-06 — the legacy `{main,fallback}` slot lookup
 * was dropped): reads the matching NON-managed `credentials[]` entry (apiKey
 * top-level, aws* under `settings`). Returns null when there's no org context,
 * no credential uses that provider, only a managed credential matches, or the
 * blob is non-v2 — callers then fall back to Kodus env keys (the setup wizard,
 * before anything is saved).
 *
 * Only `apiKey` and the Bedrock auth fields (bearer token, access key id,
 * secret access key, session token) are stored encrypted (see `encryptSlot` /
 * `encryptCredentialSecrets` in create-or-update.use-case.ts); the rest are
 * plaintext. Never log a decrypted value — this is a server-only path.
 */
export async function resolveByokSlot(
    organizationParametersService: IOrganizationParametersService,
    provider: string,
    organizationAndTeamData?: OrganizationAndTeamData,
): Promise<DecryptedByokSlot | null> {
    if (!organizationAndTeamData?.organizationId) {
        return null;
    }

    const parameter = await organizationParametersService
        .findByKey(
            OrganizationParametersKey.BYOK_CONFIG,
            organizationAndTeamData,
        )
        .catch(() => null);

    const config = parameter?.configValue;

    // v2 shape: the credential lives in credentials[], with the apiKey at the
    // top level and the aws* secrets under settings. Unlike resolveModelSlot
    // (which carries ciphertext by design and NEVER decrypts), the probe needs
    // plaintext — so this v2 branch reads credentials[] and safeDecrypt's the
    // secret fields (server-only path; DecryptedByokSlot never reaches a
    // client). A managed credential is never probed. RESEARCH §13.2 / Pattern 3.
    if (isByokConfig(config)) {
        const cred = (config.credentials ?? []).find(
            (c) => c && c.provider === provider && !c.managed,
        );
        if (!cred) {
            return null;
        }

        const settings = (cred.settings ?? {}) as Record<string, unknown>;
        const str = (v: unknown): string | undefined =>
            typeof v === 'string' && v ? v : undefined;

        return {
            provider: cred.provider,
            apiKey: safeDecrypt(cred.apiKey),
            baseURL: str(settings.baseURL),
            // model is not part of a credential — the caller supplies it.
            model: undefined,
            vertexLocation: str(settings.vertexLocation),
            awsBearerToken: safeDecrypt(str(settings.awsBearerToken)),
            awsAccessKeyId: safeDecrypt(str(settings.awsAccessKeyId)),
            awsSecretAccessKey: safeDecrypt(str(settings.awsSecretAccessKey)),
            awsRegion: str(settings.awsRegion),
            awsSessionToken: safeDecrypt(str(settings.awsSessionToken)),
            codexAccessToken: safeDecrypt(str(settings.codexAccessToken)),
            codexRefreshToken: safeDecrypt(str(settings.codexRefreshToken)),
            accountId: str(settings.accountId),
        };
    }

    // Non-v2 / absent blob: no stored credential to probe (04b-06 — the legacy
    // {main,fallback} slot lookup was dropped). Callers fall back to Kodus env keys.
    return null;
}

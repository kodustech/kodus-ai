import { decrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IOrganizationParametersService } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';

import { type BYOKSlot } from './byok-config.util';

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
 * Resolve the org's OWN stored credentials for `provider` (matching either the
 * main or fallback BYOK slot), decrypting the sensitive fields. Returns null
 * when there's no org context or no slot uses that provider — callers then fall
 * back to Kodus env keys (the setup wizard, before anything is saved).
 *
 * Only `apiKey` and the Bedrock auth fields (bearer token, access key id,
 * secret access key, session token) are stored encrypted (see `encryptSlot` in
 * create-or-update.use-case.ts); the rest are plaintext.
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

    const config = parameter?.configValue as
        | { main?: BYOKSlot; fallback?: BYOKSlot }
        | undefined;

    const slot = [config?.main, config?.fallback].find(
        (s) => s?.provider === provider,
    );
    if (!slot) {
        return null;
    }

    return {
        provider: slot.provider,
        apiKey: safeDecrypt(slot.apiKey),
        baseURL: slot.baseURL,
        model: slot.model,
        vertexLocation: slot.vertexLocation,
        awsBearerToken: safeDecrypt(slot.awsBearerToken),
        awsAccessKeyId: safeDecrypt(slot.awsAccessKeyId),
        awsSecretAccessKey: safeDecrypt(slot.awsSecretAccessKey),
        awsRegion: slot.awsRegion,
        awsSessionToken: safeDecrypt(slot.awsSessionToken),
    };
}

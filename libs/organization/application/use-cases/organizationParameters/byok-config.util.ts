import { BYOKProvider } from '@libs/llm/model-providers';
import type { BYOKConfig } from '@libs/llm/byok-config';

import type {
    BYOKCredential,
    BYOKModelConfig,
} from '@libs/llm/byok-config';

/**
 * A single BYOK credential slot — the `main` (or `fallback`) block of a
 * stored BYOK config.
 */
export type BYOKSlot = BYOKConfig['main'];

const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Whether a BYOK credential slot carries the credentials it needs to run.
 *
 * Most providers authenticate with a single `apiKey` — Google Vertex
 * stores its base64-encoded service-account JSON in that same field, so
 * it is covered too. Amazon Bedrock is the exception: it has no `apiKey`
 * and authenticates with either a bearer token (`awsBearerToken`) or
 * static IAM credentials (`awsAccessKeyId` + `awsSecretAccessKey`).
 *
 * Keep in sync with the auth paths in `bedrockModelFromCredentials`
 * (byok-to-vercel.ts) and the save-time validation in `encryptSlot`
 * (create-or-update.use-case.ts).
 */
export function isByokSlotConfigured(
    slot: Partial<BYOKSlot> | null | undefined,
): boolean {
    if (!slot) {
        return false;
    }

    if (slot.provider === BYOKProvider.AMAZON_BEDROCK) {
        return Boolean(
            slot.awsBearerToken ||
                (slot.awsAccessKeyId && slot.awsSecretAccessKey),
        );
    }

    return Boolean(slot.apiKey);
}

/**
 * Per-model resolvability for the v2 multi-model status (05-07).
 *
 * A v2 model "resolves" when the pipeline could actually run it:
 *  - a MANAGED / env-default credential → resolves iff the env-default LLM is
 *    reachable (`describeEnvLLMConfig().configured`), because a managed model
 *    normalizes to the env path and carries no BYOK material of its own;
 *  - a real BYOK credential → resolves iff the provider is set, the model names
 *    a model, and the credential carries usable material for its provider
 *    (`isByokSlotConfigured`, including Bedrock's aws* auth).
 *
 * Only credential MATERIAL is inspected here to build the boolean — the caller
 * must never surface the reconstructed slot's secret fields. Nothing secret is
 * returned; the function yields a boolean only.
 */
export function isV2ModelResolvable(
    model: Pick<BYOKModelConfig, 'model' | 'credentialId'> | null | undefined,
    credential: BYOKCredential | null | undefined,
    envReachable: boolean,
): boolean {
    if (!model || !credential) {
        return false;
    }

    // A managed credential is the Kodus env-default; it resolves only when the
    // env-default LLM is actually reachable on this self-hosted install.
    if (credential.managed) {
        return envReachable;
    }

    if (!asString(credential.provider) || !asString(model.model)) {
        return false;
    }

    const settings = (credential.settings ?? {}) as Record<string, unknown>;
    // Reconstruct only the provider + auth-material fields the provider-aware
    // `isByokSlotConfigured` check reads. This local slot is NEVER returned.
    const slot: Partial<BYOKSlot> = {
        provider: credential.provider as BYOKSlot['provider'],
        apiKey: asString(credential.apiKey),
        awsBearerToken: asString(settings.awsBearerToken),
        awsAccessKeyId: asString(settings.awsAccessKeyId),
        awsSecretAccessKey: asString(settings.awsSecretAccessKey),
    };

    return isByokSlotConfigured(slot);
}

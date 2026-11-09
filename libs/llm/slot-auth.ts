import { BYOKProvider } from './model-providers';
import { isPlatformFundedProvider } from './platform-funded-provider';
import type { NormalizedModel } from './byok-config';

/**
 * Whether a BYOK credential slot carries the credentials it needs to run.
 *
 * Most providers authenticate with a single `apiKey` — Google Vertex stores its
 * base64-encoded service-account JSON in that same field, so it is covered too.
 * Amazon Bedrock is the exception: it has no `apiKey` and authenticates with
 * either a bearer token (`awsBearerToken`) or static IAM credentials
 * (`awsAccessKeyId` + `awsSecretAccessKey`).
 *
 * Keep in sync with the auth paths in `bedrockModelFromCredentials`
 * (byok-to-vercel.ts) and the save-time validation in `encryptSlot`
 * (create-or-update.use-case.ts).
 */
export function isByokSlotConfigured(
    slot: Partial<NormalizedModel> | null | undefined,
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

    // Platform-funded (`kodus`): no material of its own, by design.
    if (isPlatformFundedProvider(slot.provider)) {
        return true;
    }

    return Boolean(slot.apiKey);
}

import {
    SealedTokenError,
    sealedTokens,
} from '@libs/common/utils/sealed-token';

/**
 * A preview the settings page can post later, as it was shown: the result is
 * sealed with an HMAC and posted only when the seal holds, so a post never
 * re-runs the check (it would cost a second run and could read differently),
 * and never lands on a PR the preview was not for.
 *
 * The key is derived with HKDF-SHA256 from API_CRYPTO_KEY under a label of its
 * own, used for nothing else.
 */

const KEY_LABEL = 'kodus/business-logic-preview/v1';
/** Long enough to read a preview and post it. */
export const PREVIEW_TTL_MS = 30 * 60 * 1000;

export class PreviewSealError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PreviewSealError';
    }
}

const tokens = sealedTokens<unknown>(KEY_LABEL, PREVIEW_TTL_MS);

export function sealPreview<T>(payload: T, now = Date.now()): string {
    return tokens.seal(payload, now);
}

export function openPreview<T>(token: string, now = Date.now()): T {
    try {
        return tokens.open(token, now) as T;
    } catch (err) {
        if (err instanceof SealedTokenError) {
            throw new PreviewSealError(
                err.reason === 'expired'
                    ? 'The preview expired: run the check again.'
                    : 'The preview is not one Kody made.',
            );
        }
        throw err;
    }
}

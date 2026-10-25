import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

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

function previewKey(): Buffer {
    const ikm = Buffer.from(process.env.API_CRYPTO_KEY ?? '', 'hex');
    if (ikm.length !== 32) {
        throw new Error('API_CRYPTO_KEY must be 32 bytes in hexadecimal.');
    }
    return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), KEY_LABEL, 32));
}

const sign = (data: string) =>
    createHmac('sha256', previewKey()).update(data).digest('base64url');

export function sealPreview<T>(payload: T, now = Date.now()): string {
    const data = Buffer.from(
        JSON.stringify({ payload, expiresAt: now + PREVIEW_TTL_MS }),
    ).toString('base64url');
    return `${data}.${sign(data)}`;
}

export function openPreview<T>(token: string, now = Date.now()): T {
    const [data, signature] = token.split('.');
    if (!data || !signature) {
        throw new PreviewSealError('The preview is not one Kody made.');
    }
    const expected = Buffer.from(sign(data));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        throw new PreviewSealError('The preview is not one Kody made.');
    }
    const { payload, expiresAt } = JSON.parse(
        Buffer.from(data, 'base64url').toString('utf8'),
    ) as { payload: T; expiresAt: number };
    if (now > expiresAt) {
        throw new PreviewSealError('The preview expired: run the check again.');
    }
    return payload;
}

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Keys and short-lived tokens derived from API_CRYPTO_KEY.
 *
 * Each use names a label of its own, and HKDF-SHA256 turns API_CRYPTO_KEY into
 * a separate key per label, so a token sealed for one use never opens as
 * another and no use ever holds API_CRYPTO_KEY itself.
 */

const derived = new Map<string, { material: string; key: Buffer }>();

/** A 32-byte key for `label`, derived from API_CRYPTO_KEY. */
export function deriveCryptoKey(label: string): Buffer {
    const material = process.env.API_CRYPTO_KEY ?? '';
    const cached = derived.get(label);
    if (cached?.material === material) return cached.key;

    const ikm = Buffer.from(material, 'hex');
    if (ikm.length !== 32) {
        throw new Error('API_CRYPTO_KEY must be 32 bytes in hexadecimal.');
    }
    const key = Buffer.from(
        hkdfSync('sha256', ikm, Buffer.alloc(0), label, 32),
    );
    derived.set(label, { material, key });
    return key;
}

export class SealedTokenError extends Error {
    constructor(readonly reason: 'invalid' | 'expired') {
        super(
            reason === 'expired'
                ? 'The token expired.'
                : 'The token is not one Kodus sealed.',
        );
        this.name = 'SealedTokenError';
    }
}

/**
 * Seal a payload so it can travel through the client and come back unchanged:
 * `base64url(JSON {payload, expiresAt}).base64url(HMAC)`. The payload is
 * readable, not secret.
 */
export function sealedTokens<T>(label: string, ttlMs: number) {
    const sign = (data: string) =>
        createHmac('sha256', deriveCryptoKey(label))
            .update(data)
            .digest('base64url');

    return {
        seal(payload: T, now = Date.now()): string {
            const data = Buffer.from(
                JSON.stringify({ payload, expiresAt: now + ttlMs }),
            ).toString('base64url');
            return `${data}.${sign(data)}`;
        },

        open(token: unknown, now = Date.now()): T {
            const [data, signature, extra] =
                typeof token === 'string' ? token.split('.') : [];
            if (!data || !signature || extra !== undefined) {
                throw new SealedTokenError('invalid');
            }
            const expected = Buffer.from(sign(data));
            const given = Buffer.from(signature);
            if (
                expected.length !== given.length ||
                !timingSafeEqual(expected, given)
            ) {
                throw new SealedTokenError('invalid');
            }
            const { payload, expiresAt } = JSON.parse(
                Buffer.from(data, 'base64url').toString('utf8'),
            ) as { payload?: T; expiresAt?: unknown };
            // Signed with this label but not in this shape: a token from an
            // earlier format of the same use.
            if (payload === undefined || typeof expiresAt !== 'number') {
                throw new SealedTokenError('invalid');
            }
            if (!(now <= expiresAt)) {
                throw new SealedTokenError('expired');
            }
            return payload;
        },
    };
}

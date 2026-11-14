import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * A secret the product hands the Runtime (the repo token, the Run token)
 * travels sealed: AES-256-GCM under a key only the product and the
 * runtime-worker hold, bound to the Run it belongs to. It is stored that way
 * in the outbox, RabbitMQ, any dead-letter copy and the workflow engine's
 * inputs, and opened only inside the step that uses it, so none of those
 * stores ever holds a usable credential.
 *
 * Format: `sealed:v1:<base64url(iv | tag | ciphertext)>`.
 */
export const SEALED_PREFIX = 'sealed:v1:';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type SealedSecret = string & { readonly __sealed: unique symbol };

export class SealedSecretError extends Error {
    constructor(message: string) {
        super(`sealed secret: ${message}`);
        this.name = 'SealedSecretError';
    }
}

/**
 * The 32-byte key from its configured form: 64 hex characters or base64 of
 * 32 bytes. Anything else is refused, so a short or mistyped key fails at
 * boot instead of sealing with something guessable.
 */
export function sealingKeyFrom(configured: string | undefined): Buffer {
    const value = (configured ?? '').trim();
    const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
    if (key.length !== KEY_BYTES) {
        throw new SealedSecretError('the key must be 32 bytes, as 64 hex characters or base64');
    }
    return key;
}

/** `boundTo` is the Run's id: a sealed token cannot be replayed on another Run. */
export function sealSecret(plain: string, key: Buffer, boundTo: string): SealedSecret {
    if (!boundTo) throw new SealedSecretError('a sealed secret is bound to a Run id');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(boundTo, 'utf8'));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return (SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')) as SealedSecret;
}

export function isSealedSecret(value: unknown): value is SealedSecret {
    return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

/** Opens what sealSecret made for the same Run; a wrong key, Run or byte throws. */
export function openSecret(sealed: string, key: Buffer, boundTo: string): string {
    if (!isSealedSecret(sealed)) throw new SealedSecretError('not sealed');
    const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new SealedSecretError('truncated');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(boundTo, 'utf8'));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
        return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
        throw new SealedSecretError('does not open with this key for this Run');
    }
}

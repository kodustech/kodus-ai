import {
    createCipheriv,
    createDecipheriv,
    hkdfSync,
    randomBytes,
} from 'node:crypto';

/**
 * Encryption of custom agent CLI secrets at rest (#2172): AES-256-GCM, so a
 * stored value cannot be altered or swapped without decryption failing.
 *
 * - Key: derived with HKDF-SHA256 from API_CRYPTO_KEY under a label of its
 *   own. No new key to provision, and the derived key is used for nothing
 *   else: CLI secrets never share a key with the CBC helper the rest of the
 *   platform uses for its ciphertexts.
 * - Associated data: the slot the secret belongs to (agent id, CLI name, env
 *   name). A ciphertext copied into another agent's or CLI's slot does not
 *   decrypt there.
 * - Format: `kcs1:<iv>:<ciphertext>:<tag>`, base64url, 96-bit random IV,
 *   128-bit tag. Anything else is unreadable: there is no older format to
 *   fall back to, and an unreadable secret must be typed again.
 */

const VERSION = 'kcs1';
const KEY_LABEL = 'kodus/custom-agent-cli-secret/v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type CliSecretSlot = {
    agentId: string;
    cliName: string;
    env: string;
};

export class CliSecretUnreadableError extends Error {
    constructor() {
        super('CLI secret cannot be decrypted');
        this.name = 'CliSecretUnreadableError';
    }
}

let cachedKey: { material: string; key: Buffer } | undefined;

function cliSecretKey(): Buffer {
    const material = process.env.API_CRYPTO_KEY ?? '';
    if (cachedKey?.material === material) return cachedKey.key;
    const ikm = Buffer.from(material, 'hex');
    if (ikm.length !== 32) {
        throw new Error('API_CRYPTO_KEY must be 32 bytes in hexadecimal.');
    }
    const key = Buffer.from(
        hkdfSync('sha256', ikm, Buffer.alloc(0), KEY_LABEL, 32),
    );
    cachedKey = { material, key };
    return key;
}

const slotData = (slot: CliSecretSlot) =>
    Buffer.from(
        [VERSION, slot.agentId ?? '', slot.cliName ?? '', slot.env ?? ''].join(
            '\u0000',
        ),
        'utf8',
    );

export function encryptCliSecret(
    plaintext: string,
    slot: CliSecretSlot,
): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', cliSecretKey(), iv, {
        authTagLength: TAG_BYTES,
    });
    cipher.setAAD(slotData(slot));
    const body = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    return [
        VERSION,
        iv.toString('base64url'),
        body.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
    ].join(':');
}

/** Whether a stored value has this module's format (not whether it decrypts). */
export function isCliSecretCiphertext(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const parts = value.split(':');
    return parts.length === 4 && parts[0] === VERSION;
}

/** The plaintext, or CliSecretUnreadableError for anything that is not a
 *  ciphertext of this slot under the current key. */
export function decryptCliSecret(
    ciphertext: string,
    slot: CliSecretSlot,
): string {
    if (!isCliSecretCiphertext(ciphertext)) {
        throw new CliSecretUnreadableError();
    }
    const [, ivText, bodyText, tagText] = ciphertext.split(':');
    const iv = Buffer.from(ivText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new CliSecretUnreadableError();
    }
    try {
        const decipher = createDecipheriv('aes-256-gcm', cliSecretKey(), iv, {
            authTagLength: TAG_BYTES,
        });
        decipher.setAAD(slotData(slot));
        decipher.setAuthTag(tag);
        return Buffer.concat([
            decipher.update(Buffer.from(bodyText, 'base64url')),
            decipher.final(),
        ]).toString('utf8');
    } catch {
        throw new CliSecretUnreadableError();
    }
}

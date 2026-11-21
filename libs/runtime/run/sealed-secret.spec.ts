import { randomBytes } from 'crypto';

import { isSealedSecret, openSecret, SEALED_PREFIX, sealingKeyFrom, sealSecret, SealedSecretError } from './sealed-secret';

describe('sealed secrets', () => {
    const key = randomBytes(32);

    it('opens for the same key and Run, and the sealed form shows nothing of the secret', () => {
        const sealed = sealSecret('ghs_example_installation_token', key, 'run-1');
        expect(isSealedSecret(sealed)).toBe(true);
        expect(sealed.startsWith(SEALED_PREFIX)).toBe(true);
        expect(sealed).not.toContain('ghs_');
        expect(openSecret(sealed, key, 'run-1')).toBe('ghs_example_installation_token');
    });

    it('two seals of one secret differ (fresh IV)', () => {
        expect(sealSecret('t', key, 'run-1')).not.toBe(sealSecret('t', key, 'run-1'));
    });

    it('refuses another Run, another key, a flipped byte and plain text', () => {
        const sealed = sealSecret('t', key, 'run-1');
        expect(() => openSecret(sealed, key, 'run-2')).toThrow(SealedSecretError);
        expect(() => openSecret(sealed, randomBytes(32), 'run-1')).toThrow(SealedSecretError);
        const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64url');
        raw[raw.length - 1] ^= 1;
        expect(() => openSecret(SEALED_PREFIX + raw.toString('base64url'), key, 'run-1')).toThrow(SealedSecretError);
        expect(() => openSecret('ghs_plain', key, 'run-1')).toThrow(SealedSecretError);
        expect(() => openSecret(SEALED_PREFIX + 'AAAA', key, 'run-1')).toThrow(SealedSecretError);
        expect(() => sealSecret('t', key, '')).toThrow(SealedSecretError);
    });

    it('reads the key as 64 hex characters or base64 of 32 bytes, and refuses anything else', () => {
        const hex = key.toString('hex');
        expect(sealingKeyFrom(hex).equals(key)).toBe(true);
        expect(sealingKeyFrom(key.toString('base64')).equals(key)).toBe(true);
        for (const bad of [undefined, '', 'short', hex.slice(2), randomBytes(16).toString('base64')]) {
            expect(() => sealingKeyFrom(bad)).toThrow(SealedSecretError);
        }
    });
});

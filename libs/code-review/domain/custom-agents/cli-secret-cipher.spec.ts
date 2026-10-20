import { encrypt as legacyEncrypt } from '@libs/common/utils/crypto';

import {
    CliSecretUnreadableError,
    decryptCliSecret,
    encryptCliSecret,
    isCliSecretCiphertext,
} from './cli-secret-cipher';

const slot = {
    agentId: 'ledger-agent',
    cliName: 'ledgerctl',
    env: 'LEDGER_TOKEN',
};
const SECRET = 'lk_live_9f8e7d6c5b4a3210';

describe('CLI secret cipher (AES-256-GCM)', () => {
    it('round-trips a value in its own slot, with a fresh IV each time', () => {
        const a = encryptCliSecret(SECRET, slot);
        const b = encryptCliSecret(SECRET, slot);
        expect(a).not.toBe(b);
        expect(isCliSecretCiphertext(a)).toBe(true);
        expect(a).not.toContain(SECRET);
        expect(decryptCliSecret(a, slot)).toBe(SECRET);
    });

    it('refuses a ciphertext whose bytes were altered', () => {
        const [v, iv, body, tag] = encryptCliSecret(SECRET, slot).split(':');
        const raw = Buffer.from(body, 'base64url');
        raw[0] ^= 0x01;
        const flipped = [v, iv, raw.toString('base64url'), tag].join(':');
        expect(() => decryptCliSecret(flipped, slot)).toThrow(
            CliSecretUnreadableError,
        );
    });

    it.each([
        ['another agent', { ...slot, agentId: 'other-agent' }],
        ['another CLI', { ...slot, cliName: 'otherctl' }],
        ['another env name', { ...slot, env: 'OTHER_TOKEN' }],
    ])('refuses a ciphertext moved to %s', (_name, other) => {
        const ciphertext = encryptCliSecret(SECRET, slot);
        expect(() => decryptCliSecret(ciphertext, other)).toThrow(
            CliSecretUnreadableError,
        );
    });

    it('has no fallback to the platform CBC format', () => {
        const legacy = legacyEncrypt(SECRET);
        expect(isCliSecretCiphertext(legacy)).toBe(false);
        expect(() => decryptCliSecret(legacy, slot)).toThrow(
            CliSecretUnreadableError,
        );
    });

    it('does not use the platform key directly', () => {
        const ciphertext = encryptCliSecret(SECRET, slot);
        const [, iv, body, tag] = ciphertext.split(':');
        const { createDecipheriv } = jest.requireActual('node:crypto');
        const decipher = createDecipheriv(
            'aes-256-gcm',
            Buffer.from(process.env.API_CRYPTO_KEY!, 'hex'),
            Buffer.from(iv, 'base64url'),
        );
        decipher.setAAD(
            Buffer.from(
                ['kcs1', slot.agentId, slot.cliName, slot.env].join('\u0000'),
            ),
        );
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        expect(() =>
            Buffer.concat([
                decipher.update(Buffer.from(body, 'base64url')),
                decipher.final(),
            ]),
        ).toThrow();
    });
});

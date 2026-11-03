import { createHmac } from 'node:crypto';

import { deriveCryptoKey } from '@libs/common/utils/sealed-token';

import {
    INVITATION_TTL_MS,
    isInvitedEmail,
    openInvitation,
    sealInvitation,
} from './invitation-token';

describe('invitation token', () => {
    let previous: string | undefined;

    beforeEach(() => {
        previous = process.env.API_CRYPTO_KEY;
        process.env.API_CRYPTO_KEY = 'b'.repeat(64);
    });

    afterEach(() => {
        process.env.API_CRYPTO_KEY = previous;
    });

    /** A token signed with the invitation key, around any body. */
    const signedAs = (body: unknown) => {
        const data = Buffer.from(JSON.stringify(body)).toString('base64url');
        const signature = createHmac(
            'sha256',
            deriveCryptoKey('kodus/user-invitation/v1'),
        )
            .update(data)
            .digest('base64url');
        return `${data}.${signature}`;
    };

    it('names the invited user and the address, in lower case, for seven days', () => {
        const token = sealInvitation(
            { userId: 'u-1', email: 'Dev@Example.TEST' },
            0,
        );

        expect(openInvitation(token, INVITATION_TTL_MS)).toEqual({
            userId: 'u-1',
            email: 'dev@example.test',
        });
        expect(openInvitation(token, INVITATION_TTL_MS + 1)).toBeNull();
    });

    it('is not the bare user id, and a user id does not open', () => {
        const token = sealInvitation({ userId: 'u-1', email: 'a@b.test' });

        expect(token).not.toContain('u-1');
        expect(openInvitation('u-1')).toBeNull();
    });

    it('refuses a signed token whose claims are not both strings', () => {
        const expiresAt = Date.now() + 1000;
        for (const payload of [
            { userId: 1, email: 'a@b.test' },
            { userId: 'u-1', email: 2 },
            { userId: 'u-1' },
            { email: 'a@b.test' },
        ]) {
            expect(openInvitation(signedAs({ payload, expiresAt }))).toBeNull();
        }
    });

    it('does not hide a missing API_CRYPTO_KEY as an invalid invitation', () => {
        const token = sealInvitation({ userId: 'u-1', email: 'a@b.test' });
        delete process.env.API_CRYPTO_KEY;

        expect(() => openInvitation(token)).toThrow('API_CRYPTO_KEY');
    });

    it('matches the invited address whatever its case, and nothing else', () => {
        const claims = { userId: 'u-1', email: 'dev@example.test' };

        expect(isInvitedEmail(claims, 'DEV@example.test')).toBe(true);
        expect(isInvitedEmail(claims, 'other@example.test')).toBe(false);
        expect(isInvitedEmail(claims, '')).toBe(false);
        expect(isInvitedEmail(claims, undefined)).toBe(false);
    });
});

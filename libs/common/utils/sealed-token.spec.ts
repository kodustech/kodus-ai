import {
    deriveCryptoKey,
    SealedTokenError,
    sealedTokens,
} from './sealed-token';

describe('sealed tokens', () => {
    const KEY = 'a'.repeat(64);
    let previous: string | undefined;

    beforeAll(() => {
        previous = process.env.API_CRYPTO_KEY;
        process.env.API_CRYPTO_KEY = KEY;
    });

    afterAll(() => {
        process.env.API_CRYPTO_KEY = previous;
    });

    const tokens = sealedTokens<{ id: string }>('test/one/v1', 1000);

    const reason = (fn: () => unknown) => {
        try {
            fn();
        } catch (err) {
            return err instanceof SealedTokenError ? err.reason : String(err);
        }
        return 'opened';
    };

    it('opens what it sealed, until it expires', () => {
        const token = tokens.seal({ id: '42' }, 0);

        expect(tokens.open(token, 1000)).toEqual({ id: '42' });
        expect(reason(() => tokens.open(token, 1001))).toBe('expired');
    });

    it('refuses a payload changed after sealing', () => {
        const [, signature] = tokens.seal({ id: '42' }, 0).split('.');
        const forged = Buffer.from(
            JSON.stringify({ payload: { id: '43' }, expiresAt: 1000 }),
        ).toString('base64url');

        expect(reason(() => tokens.open(`${forged}.${signature}`, 0))).toBe(
            'invalid',
        );
    });

    it('refuses a token sealed under another label', () => {
        const other = sealedTokens<{ id: string }>('test/two/v1', 1000);

        expect(reason(() => tokens.open(other.seal({ id: '42' }, 0), 0))).toBe(
            'invalid',
        );
    });

    it('refuses a token signed under its label but in another shape', () => {
        const { createHmac } = jest.requireActual(
            'node:crypto',
        ) as typeof import('node:crypto');
        const data = Buffer.from(
            JSON.stringify({ id: '42', expiresAt: 1000 }),
        ).toString('base64url');
        const signature = createHmac('sha256', deriveCryptoKey('test/one/v1'))
            .update(data)
            .digest('base64url');

        expect(reason(() => tokens.open(`${data}.${signature}`, 0))).toBe(
            'invalid',
        );
    });

    const signedAs = (body: unknown) => {
        const { createHmac } = jest.requireActual(
            'node:crypto',
        ) as typeof import('node:crypto');
        const data = Buffer.from(JSON.stringify(body)).toString('base64url');
        const signature = createHmac('sha256', deriveCryptoKey('test/one/v1'))
            .update(data)
            .digest('base64url');
        return `${data}.${signature}`;
    };

    it('refuses a signed token whose expiry is not a number', () => {
        // `now <= "9999999999999"` would coerce the string and open it.
        for (const expiresAt of ['9999999999999', null, undefined]) {
            expect(
                reason(() =>
                    tokens.open(
                        signedAs({ payload: { id: '42' }, expiresAt }),
                        0,
                    ),
                ),
            ).toBe('invalid');
        }
    });

    it('refuses a valid token with anything appended', () => {
        const token = tokens.seal({ id: '42' }, 0);

        expect(reason(() => tokens.open(`${token}.x`, 0))).toBe('invalid');
    });

    it('refuses a signature of another length as invalid, not as a crash', () => {
        const token = tokens.seal({ id: '42' }, 0);

        expect(reason(() => tokens.open(token.slice(0, -2), 0))).toBe(
            'invalid',
        );
        expect(reason(() => tokens.open(`${token}AA`, 0))).toBe('invalid');
    });

    it('says why it refused', () => {
        const expired = new SealedTokenError('expired');
        const invalid = new SealedTokenError('invalid');

        expect(expired.name).toBe('SealedTokenError');
        expect(expired.message).toBe('The token expired.');
        expect(invalid.message).toBe('The token is not one Kodus sealed.');
    });

    it('refuses what is not a token', () => {
        for (const value of [undefined, 42, '', 'abc', 'a.b.c']) {
            expect(reason(() => tokens.open(value, 0))).toBe('invalid');
        }
    });

    it('derives a different key per label and refuses a short API_CRYPTO_KEY', () => {
        expect(deriveCryptoKey('test/one/v1')).not.toEqual(
            deriveCryptoKey('test/two/v1'),
        );

        process.env.API_CRYPTO_KEY = 'abcd';
        expect(() => deriveCryptoKey('test/one/v1')).toThrow('32 bytes');
        delete process.env.API_CRYPTO_KEY;
        expect(() => deriveCryptoKey('test/one/v1')).toThrow('32 bytes');
        process.env.API_CRYPTO_KEY = KEY;
    });
});

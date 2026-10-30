import { openPreview, PREVIEW_TTL_MS, sealPreview } from './preview-seal';

describe('preview seal', () => {
    const key = process.env.API_CRYPTO_KEY;
    beforeAll(() => {
        process.env.API_CRYPTO_KEY = 'ab'.repeat(32);
    });
    afterAll(() => {
        process.env.API_CRYPTO_KEY = key;
    });

    it('opens what it sealed, and nothing altered or expired', () => {
        const token = sealPreview(
            { prUrl: 'https://x/pr/1', passed: false },
            0,
        );
        expect(openPreview(token, 1)).toEqual({
            prUrl: 'https://x/pr/1',
            passed: false,
        });

        const [data, signature] = token.split('.');
        const forged = Buffer.from(
            Buffer.from(data, 'base64url')
                .toString('utf8')
                .replace('"passed":false', '"passed":true'),
        ).toString('base64url');
        expect(() => openPreview(`${forged}.${signature}`, 1)).toThrow(
            'not one Kody made',
        );
        expect(() => openPreview(token, PREVIEW_TTL_MS + 1)).toThrow('expired');
    });
});

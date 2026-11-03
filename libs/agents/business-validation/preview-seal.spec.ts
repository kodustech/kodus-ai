import {
    openPreview,
    PREVIEW_TTL_MS,
    PreviewSealError,
    sealPreview,
} from './preview-seal';

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

    // Previews already shown when this ships must still post.
    it('opens a preview sealed by the earlier implementation', () => {
        const { createHmac, hkdfSync } = jest.requireActual(
            'node:crypto',
        ) as typeof import('node:crypto');
        const key = Buffer.from(
            hkdfSync(
                'sha256',
                Buffer.from(process.env.API_CRYPTO_KEY ?? '', 'hex'),
                Buffer.alloc(0),
                'kodus/business-logic-preview/v1',
                32,
            ),
        );
        const data = Buffer.from(
            JSON.stringify({
                payload: { prNumber: 7, verdict: 'ok' },
                expiresAt: 1000 + PREVIEW_TTL_MS,
            }),
        ).toString('base64url');
        const signature = createHmac('sha256', key)
            .update(data)
            .digest('base64url');

        expect(openPreview(`${data}.${signature}`, 1000)).toEqual({
            prNumber: 7,
            verdict: 'ok',
        });
    });

    it('names its refusal, and does not call a missing API_CRYPTO_KEY a bad preview', () => {
        let refusal: unknown;
        try {
            openPreview('junk');
        } catch (err) {
            refusal = err;
        }
        expect(refusal).toBeInstanceOf(PreviewSealError);
        expect((refusal as Error).name).toBe('PreviewSealError');

        const token = sealPreview({ a: 1 });
        const previous = process.env.API_CRYPTO_KEY;
        delete process.env.API_CRYPTO_KEY;
        try {
            expect(() => openPreview(token)).toThrow('API_CRYPTO_KEY');
        } finally {
            process.env.API_CRYPTO_KEY = previous;
        }
    });
});

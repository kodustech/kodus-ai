import {
    FIRST_TOUCH_TEXT_MAX,
    FIRST_TOUCH_URL_MAX,
    sanitizeFirstTouch,
} from './first-touch';

describe('sanitizeFirstTouch', () => {
    const now = new Date('2026-10-29T12:00:00.000Z');

    it('keeps a paid-search first touch as sent by the GTM tag', () => {
        expect(
            sanitizeFirstTouch(
                {
                    utm_source: 'google',
                    utm_medium: 'cpc',
                    utm_campaign: 'test',
                    gclid: 'TEST',
                    referrer: 'https://www.google.com/',
                    landing_page:
                        'https://kodus.io/?utm_source=google&utm_medium=cpc&utm_campaign=test&gclid=TEST',
                    captured_at: '2026-10-29T11:59:00.000Z',
                },
                now,
            ),
        ).toEqual({
            utm_source: 'google',
            utm_medium: 'cpc',
            utm_campaign: 'test',
            gclid: 'TEST',
            referrer: 'https://www.google.com/',
            landing_page:
                'https://kodus.io/?utm_source=google&utm_medium=cpc&utm_campaign=test&gclid=TEST',
            captured_at: '2026-10-29T11:59:00.000Z',
        });
    });

    it('keeps only landing page and timestamp for a direct visit', () => {
        expect(
            sanitizeFirstTouch(
                {
                    referrer: '',
                    landing_page: 'https://kodus.io/en/pricing/',
                    captured_at: '2026-10-29T11:59:00.000Z',
                },
                now,
            ),
        ).toEqual({
            landing_page: 'https://kodus.io/en/pricing/',
            captured_at: '2026-10-29T11:59:00.000Z',
        });
    });

    it.each([undefined, null, 'utm_source=google', 42, ['google'], {}])(
        'returns null for %p',
        (input) => {
            expect(sanitizeFirstTouch(input, now)).toBeNull();
        },
    );

    it('drops unknown keys and non-string values', () => {
        expect(
            sanitizeFirstTouch(
                {
                    utm_source: 'linkedin',
                    utm_medium: 7,
                    utm_campaign: { nested: true },
                    email: 'jane@acme.com',
                    fbclid: 'abc',
                },
                now,
            ),
        ).toEqual({ utm_source: 'linkedin' });
    });

    it('trims, strips control characters and truncates text fields', () => {
        const result = sanitizeFirstTouch(
            {
                utm_source: '  news\u0000letter\n ',
                utm_content: 'x'.repeat(FIRST_TOUCH_TEXT_MAX + 50),
            },
            now,
        );

        expect(result?.utm_source).toBe('newsletter');
        expect(result?.utm_content).toHaveLength(FIRST_TOUCH_TEXT_MAX);
    });

    it('drops values that carry an email address', () => {
        expect(
            sanitizeFirstTouch(
                {
                    utm_source: 'newsletter',
                    utm_term: 'jane.doe@acme.com',
                    utm_content: 'hi Jane.Doe+ads@Acme.co.uk!',
                },
                now,
            ),
        ).toEqual({ utm_source: 'newsletter' });
    });

    it('drops an email that starts before the truncation point', () => {
        expect(
            sanitizeFirstTouch(
                {
                    utm_content: `${'x'.repeat(FIRST_TOUCH_TEXT_MAX - 5)} jane.doe@acme.com`,
                },
                now,
            ),
        ).toBeNull();
    });

    it('stays fast on long hostile input (the public signup endpoint takes 25mb bodies)', () => {
        const hostile = '%'.repeat(1_000_000);
        const atSigns = 'a@'.repeat(500_000);
        const started = Date.now();

        expect(
            sanitizeFirstTouch(
                {
                    utm_source: hostile,
                    utm_term: atSigns,
                    referrer: `https://example.com/${hostile}`,
                    landing_page: `https://kodus.io/?utm_source=${atSigns}`,
                },
                now,
            ),
        ).toEqual({
            utm_source: '%'.repeat(FIRST_TOUCH_TEXT_MAX),
            utm_term: 'a@'.repeat(FIRST_TOUCH_TEXT_MAX / 2),
        });
        expect(Date.now() - started).toBeLessThan(200);
    });

    it('drops a gclid with characters Google never uses', () => {
        expect(sanitizeFirstTouch({ gclid: 'abc<script>' }, now)).toBeNull();
        expect(sanitizeFirstTouch({ gclid: 'Cj0K-Q_jw1' }, now)).toEqual({
            gclid: 'Cj0K-Q_jw1',
        });
    });

    describe('referrer', () => {
        it('reduces it to origin + path', () => {
            expect(
                sanitizeFirstTouch(
                    {
                        referrer:
                            'https://user:pass@news.ycombinator.com/item?id=1&email=jane@acme.com#top',
                    },
                    now,
                ),
            ).toEqual({ referrer: 'https://news.ycombinator.com/item' });
        });

        it('keeps paths with a handle but drops paths with an email', () => {
            expect(
                sanitizeFirstTouch(
                    { referrer: 'https://medium.com/@jane.doe/post' },
                    now,
                ),
            ).toEqual({ referrer: 'https://medium.com/@jane.doe/post' });
            expect(
                sanitizeFirstTouch(
                    { referrer: 'https://example.com/u/jane%40acme.com' },
                    now,
                ),
            ).toBeNull();
        });

        it.each([
            'javascript:alert(1)',
            'data:text/html,hi',
            'not a url',
            '/relative/path',
        ])('drops %p', (referrer) => {
            expect(sanitizeFirstTouch({ referrer }, now)).toBeNull();
        });
    });

    describe('landing page', () => {
        it('keeps only the campaign parameters, cleaned', () => {
            expect(
                sanitizeFirstTouch(
                    {
                        landing_page:
                            'https://kodus.io/en/?utm_source=google&email=jane@acme.com&utm_term=jane@acme.com&gclid=ok_1&ref=x#pricing',
                    },
                    now,
                ),
            ).toEqual({
                landing_page:
                    'https://kodus.io/en/?utm_source=google&gclid=ok_1',
            });
        });

        it('truncates long URLs', () => {
            const result = sanitizeFirstTouch(
                {
                    landing_page: `https://kodus.io/${'a'.repeat(FIRST_TOUCH_URL_MAX)}`,
                },
                now,
            );

            expect(result?.landing_page).toHaveLength(FIRST_TOUCH_URL_MAX);
        });
    });

    describe('captured_at', () => {
        it('normalizes to ISO', () => {
            expect(
                sanitizeFirstTouch(
                    { captured_at: '2026-10-01T10:00:00-03:00' },
                    now,
                ),
            ).toEqual({ captured_at: '2026-10-01T13:00:00.000Z' });
        });

        it.each([
            ['not a date', 'garbage'],
            ['a number', 1793236553000],
            ['two days ahead', '2026-10-31T12:00:00.000Z'],
            ['older than two years', '2024-01-01T00:00:00.000Z'],
        ])('drops %s', (_label, captured_at) => {
            expect(sanitizeFirstTouch({ captured_at }, now)).toBeNull();
        });
    });
});

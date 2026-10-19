import { capCliOutput, maskSecrets, SECRET_REDACTION } from './cli-output-mask';

const SECRET = 'lk_live_9f8e7d6c5b4a3210';

describe('maskSecrets', () => {
    it('masks the plain value wherever it appears', () => {
        const out = maskSecrets(`token=${SECRET}\nusing ${SECRET} again`, [
            SECRET,
        ]);
        expect(out).not.toContain(SECRET);
        expect(out).toBe(
            `token=${SECRET_REDACTION}\nusing ${SECRET_REDACTION} again`,
        );
    });

    it('masks the base64 and base64url spellings', () => {
        const b64 = Buffer.from(SECRET).toString('base64');
        const b64url = Buffer.from(SECRET).toString('base64url');
        const out = maskSecrets(`a=${b64} b=${b64url}`, [SECRET]);
        expect(out).not.toContain(b64.replace(/=+$/, ''));
        expect(out).not.toContain(b64url);
    });

    it('masks the secret inside a longer base64 blob at every alignment', () => {
        for (const prefix of ['u:', 'us:', 'use:', 'user:']) {
            const blob = Buffer.from(`${prefix}${SECRET}`).toString('base64');
            const out = maskSecrets(`Authorization: Basic ${blob}`, [SECRET]);
            expect(out).toContain(SECRET_REDACTION);
            expect(
                Buffer.from(
                    out.replace('Authorization: Basic ', ''),
                    'base64',
                ).toString('utf8'),
            ).not.toContain(SECRET);
        }
    });

    it.each([
        ['lower hex', Buffer.from(SECRET).toString('hex')],
        ['upper hex', Buffer.from(SECRET).toString('hex').toUpperCase()],
        [
            'byte-pair hex',
            Buffer.from(SECRET).toString('hex').match(/../g)!.join(' '),
        ],
    ])('masks the %s spelling', (_name, encoded) => {
        const out = maskSecrets(`dump: ${encoded} end`, [SECRET]);
        expect(out).toBe(`dump: ${SECRET_REDACTION} end`);
    });

    it('masks JSON-escaped and percent-encoded spellings', () => {
        const tricky = 'p@ss/"w\\rd"+é';
        const json = JSON.stringify({ token: tricky });
        const unicodeEscaped = JSON.stringify(tricky)
            .slice(1, -1)
            .replace(/"/g, '\\u0022');
        const percent = encodeURIComponent(tricky);
        const out = maskSecrets(
            [json, percent, percent.toLowerCase(), unicodeEscaped].join('\n'),
            [tricky],
        );
        expect(out).not.toContain(JSON.stringify(tricky).slice(1, -1));
        expect(out).not.toContain(percent);
        expect(out).not.toContain(percent.toLowerCase());
        expect(out.split('\n')[0]).toBe(`{"token":"${SECRET_REDACTION}"}`);
    });

    it('masks every secret, longest first', () => {
        const other = `${SECRET}_extended`;
        const out = maskSecrets(`${other} ${SECRET}`, [SECRET, other]);
        expect(out).toBe(`${SECRET_REDACTION} ${SECRET_REDACTION}`);
    });

    it('leaves text alone when there is no secret', () => {
        expect(maskSecrets('plain output', [])).toBe('plain output');
    });
});

describe('capCliOutput', () => {
    it('caps output and says so', () => {
        const out = capCliOutput('x'.repeat(50), 10);
        expect(out.startsWith('x'.repeat(10))).toBe(true);
        expect(out).toContain('truncated at 10');
        expect(capCliOutput('short', 10)).toBe('short');
    });
});

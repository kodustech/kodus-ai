import { describe, expect, it } from 'vitest';
import {
    containsSecret,
    redact,
    redactDeep,
    REDACTION_PLACEHOLDER,
} from '../redaction.js';

/**
 * Fabricated credentials with the right shape, not live ones.
 *
 * Assembled from parts at runtime rather than written as literals: a literal
 * with this shape trips GitHub's push protection, which blocks the push for a
 * string that was never a credential. The assembled value is what the redactor
 * sees, so the test is unaffected.
 */
const join = (...parts: string[]): string => parts.join('');

const SECRETS = {
    anthropic: join('sk-', 'ant-', 'api03-', 'A'.repeat(40)),
    openai: join('sk-', 'Q'.repeat(32)),
    githubPat: join(
        'github',
        '_pat_',
        '11ABCDEFG0abcdefghijklMNOPQRSTUVWXYZ012345',
    ),
    githubToken: join('gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
    aws: join('AKIA', 'IOSFODNN7EXAMPLE'),
    slack: join('xox', 'b-', '123456789012-', 'ABCDEFGHIJKLMNOP'),
    google: join('AIza', 'SyD-0123456789abcdefghijklmnopqrstuv'),
    gitlab: join('glp', 'at-', 'ABCDEFGHIJKLMNOPQRST'),
    stripe: join('sk', '_live_', 'ABCDEFGHIJKLMNOPQRSTUVWX'),
    jwt: join(
        'eyJhbGciOiJIUzI1NiJ9',
        '.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
        '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ),
};

describe('redact', () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
        it(`removes a ${name} credential`, () => {
            const redacted = redact(`here is my key: ${secret} — use it`);
            expect(redacted).not.toContain(secret);
            expect(redacted).toContain(REDACTION_PLACEHOLDER);
        });
    }

    it('removes a PEM private key block', () => {
        const input = [
            'oops:',
            '-----BEGIN RSA PRIVATE KEY-----',
            'MIIEowIBAAKCAQEA1234567890',
            '-----END RSA PRIVATE KEY-----',
            'done',
        ].join('\n');

        const redacted = redact(input);
        expect(redacted).not.toContain('MIIEowIBAAKCAQEA');
        expect(redacted).toContain('oops:');
        expect(redacted).toContain('done');
    });

    it('keeps the key name but removes the value in an assignment', () => {
        const redacted = redact('API_SECRET_TOKEN=hunter2hunter2hunter2');
        expect(redacted).toContain('API_SECRET_TOKEN');
        expect(redacted).not.toContain('hunter2hunter2hunter2');
    });

    it('removes the password from a connection string', () => {
        const redacted = redact(
            'postgres://kodus:sup3rs3cret@db.internal:5432/kodus',
        );
        expect(redacted).not.toContain('sup3rs3cret');
        expect(redacted).toContain('db.internal');
    });

    it('removes the credential from an Authorization header', () => {
        const redacted = redact('Authorization: Bearer abcdef1234567890ABCDEF');
        expect(redacted).not.toContain('abcdef1234567890ABCDEF');
        expect(redacted).toContain('Bearer');
    });

    it('leaves ordinary prose untouched', () => {
        const prose =
            'We chose the repository pattern because the service layer was doing too much.';
        expect(redact(prose)).toBe(prose);
    });

    it('is idempotent', () => {
        const once = redact(`key ${SECRETS.anthropic}`);
        expect(redact(once)).toBe(once);
    });

    it('handles empty and nullish input', () => {
        expect(redact('')).toBe('');
        expect(redact(undefined)).toBe('');
        expect(redact(null)).toBe('');
    });
});

describe('redactDeep', () => {
    it('walks nested objects and arrays', () => {
        const input = {
            command: `curl -H "Authorization: Bearer ${SECRETS.githubToken}"`,
            nested: {
                list: [`export KEY=${SECRETS.aws}`, 'harmless'],
                count: 3,
                flag: true,
            },
        };

        const output = redactDeep(input);
        const serialized = JSON.stringify(output);

        expect(serialized).not.toContain(SECRETS.githubToken);
        expect(serialized).not.toContain(SECRETS.aws);
        expect(output.nested.count).toBe(3);
        expect(output.nested.flag).toBe(true);
        expect(output.nested.list[1]).toBe('harmless');
    });
});

describe('containsSecret', () => {
    it('detects a planted secret and clears it after redaction', () => {
        const planted = `token: ${SECRETS.anthropic}`;
        expect(containsSecret(planted)).toBe(true);
        expect(containsSecret(redact(planted))).toBe(false);
    });
});

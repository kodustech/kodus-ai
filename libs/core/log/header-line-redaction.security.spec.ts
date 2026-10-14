/**
 * GHSA-rrvp-x7hh-wfxw — sensitive HTTP headers serialized into a single string
 * (e.g. an Axios `error.request._header`) escaped key-based redaction because
 * the credential lives inside a string, not under a key named `authorization`.
 *
 * The header-line redaction added to `sanitizeString` (via redactEmbeddedSecrets)
 * closes this. This spec is the exact reproduction from the advisory and must
 * keep passing — a failing assertion here is a real credential leak.
 */
const { sanitizeString } = jest.requireActual('@libs/core/log/logger') as {
    sanitizeString: (value: string) => string;
};

describe('logger — serialized HTTP header lines are redacted (GHSA-rrvp)', () => {
    const rawHeaders = [
        'GET /_apis/projects HTTP/1.1',
        'Accept: application/json',
        'Authorization: Basic dXNlcjpwYXNz',
        'Proxy-Authorization: Bearer example-proxy-token',
        'X-Api-Key: example-api-key',
        'Cookie: session=example-session',
        'Host: example.test',
        '',
        '',
    ].join('\r\n');

    it('removes every credential from the serialized request head', () => {
        const out = sanitizeString(rawHeaders);

        expect(out).toContain('[REDACTED]');
        // None of the secret values survive.
        for (const secret of [
            'dXNlcjpwYXNz',
            'example-proxy-token',
            'example-api-key',
            'session=example-session',
        ]) {
            expect(out).not.toContain(secret);
        }
        // Non-sensitive lines are untouched.
        expect(out).toContain('Accept: application/json');
        expect(out).toContain('Host: example.test');
    });
});

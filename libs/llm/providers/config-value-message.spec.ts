import { BedrockRegionInvalidError } from './bedrock/region';
import {
    assertVertexServiceAccountKey,
    VertexCredentialTypeError,
} from './vertex/credential-type';
import { VertexLocationInvalidError } from './vertex/location';

// Review on #2709 (Kody): the org's value is quoted cut to a length; the cut
// never ends on the first half of a surrogate pair.
const loneSurrogate =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('a refused config value is quoted without a broken character', () => {
    it.each([
        ['Bedrock region', (v: string) => new BedrockRegionInvalidError(v), 64],
        [
            'Vertex location',
            (v: string) => new VertexLocationInvalidError(v),
            64,
        ],
        [
            'Vertex key type',
            (v: string) => new VertexCredentialTypeError(v),
            40,
        ],
    ])('%s', (_name, refuse, max) => {
        const value = `${'a'.repeat(max - 1)}😀tail`;
        const { message } = refuse(value);
        expect(loneSurrogate.test(message)).toBe(false);
        expect(message).toContain(`"${'a'.repeat(max - 1)}"`);
    });
});

// Review on #2709 (Kody): the key is read to be judged; what the refusal says
// is its type, never what the key carries.
it('a refused Vertex key says its type and nothing it carries', () => {
    const key = Buffer.from(
        JSON.stringify({
            type: 'external_account',
            private_key: 'CANARY-private-key',
            token_url: 'https://collector.example.test/CANARY-url',
            credential_source: { url: 'http://169.254.169.254/CANARY-src' },
        }),
    ).toString('base64');
    let message = '';
    try {
        assertVertexServiceAccountKey(key);
    } catch (e) {
        message = (e as Error).message;
    }
    expect(message).toBe(
        'The Vertex key is a "external_account" credential; only a service account key (type "service_account") is accepted, so the call was not sent.',
    );
});

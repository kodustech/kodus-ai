import { BedrockRegionInvalidError } from './bedrock/region';
import {
    assertVertexServiceAccountKey,
    VertexCredentialTypeError,
} from './vertex/credential-type';
import { VertexLocationInvalidError } from './vertex/location';

// Review on #2709 (Kody): a refusal can be shown where others read it (a PR
// comment), and a value typed in the wrong field may be a secret. The message
// is a fixed sentence: the value is never quoted back.
describe('a refused config value is never quoted in the message', () => {
    const typed = 'AKIA-CANARY [link](https://evil.test) 😀';
    it.each([
        [
            'Bedrock region',
            () => new BedrockRegionInvalidError(typed),
            'The AWS region of this Bedrock key is not an AWS region name (like us-east-1), so the call was not sent.',
        ],
        [
            'Vertex location',
            () => new VertexLocationInvalidError(typed),
            'The location of this Vertex key is not a Vertex location (like global or us-central1), so the call was not sent.',
        ],
        [
            'Vertex key type',
            () => new VertexCredentialTypeError(typed),
            'The Vertex key is not a service account key (type "service_account"), so the call was not sent.',
        ],
    ])('%s', (_name, refuse, message) => {
        expect(refuse().message).toBe(message);
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
        'The Vertex key is not a service account key (type "service_account"), so the call was not sent.',
    );
});

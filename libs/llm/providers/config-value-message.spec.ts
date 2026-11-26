import { BedrockRegionInvalidError } from './bedrock/region';
import { VertexCredentialTypeError } from './vertex/credential-type';
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

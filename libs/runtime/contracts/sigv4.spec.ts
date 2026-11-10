import { EMPTY_SHA256, presignUrl, sha256Hex, signRequest, sigV4Debug, uriEncode } from './sigv4';

// The inputs and outputs below are the examples AWS publishes, copied as they
// are documented:
// - S3 "Authenticating Requests: Using Query Parameters (AWS Signature
//   Version 4)": the presigned GET of examplebucket/test.txt.
// - S3 "Signature Calculations for the Authorization Header: Transferring
//   Payload in a Single Chunk": GET Object, PUT Object, GET Bucket Lifecycle,
//   GET Bucket (List Objects).
// - The SigV4 test suite (aws-sig-v4-test-suite): get-vanilla.

const S3_EXAMPLE = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const NOW = new Date('2013-05-24T00:00:00Z');
const ORIGIN = 'https://examplebucket.s3.amazonaws.com';

describe('SigV4 presigned URL (AWS S3 query-parameter example)', () => {
    const input = { method: 'GET', origin: ORIGIN, path: '/test.txt', region: 'us-east-1', credentials: S3_EXAMPLE, now: NOW, expiresSeconds: 86_400 };

    it('signs the documented GET of test.txt to the documented signature', () => {
        expect(presignUrl(input)).toBe(
            'https://examplebucket.s3.amazonaws.com/test.txt' +
                '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
                '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
                '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
                '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
        );
    });

    it('builds the documented canonical request and string to sign', () => {
        const query: Array<[string, string]> = [
            ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
            ['X-Amz-Credential', 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request'],
            ['X-Amz-Date', '20130524T000000Z'],
            ['X-Amz-Expires', '86400'],
            ['X-Amz-SignedHeaders', 'host'],
        ];
        const d = sigV4Debug({ ...input, query, payloadHash: 'UNSIGNED-PAYLOAD' });
        expect(d.canonicalRequest).toBe(
            [
                'GET',
                '/test.txt',
                'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
                'host:examplebucket.s3.amazonaws.com',
                '',
                'host',
                'UNSIGNED-PAYLOAD',
            ].join('\n'),
        );
        expect(d.stringToSign).toBe('AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04');
        expect(d.signature).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    });

    it('signs extra headers into the URL: a PUT grant binds its content type', () => {
        const url = new URL(presignUrl({ ...input, method: 'PUT', headers: { 'Content-Type': 'image/png' }, expiresSeconds: 900 }));
        expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
        const other = new URL(presignUrl({ ...input, method: 'PUT', headers: { 'Content-Type': 'text/plain' }, expiresSeconds: 900 }));
        expect(other.searchParams.get('X-Amz-Signature')).not.toBe(url.searchParams.get('X-Amz-Signature'));
    });

    it('signs a session token into the query', () => {
        const url = new URL(presignUrl({ ...input, credentials: { ...S3_EXAMPLE, sessionToken: 'tok/en+=' } }));
        expect(url.searchParams.get('X-Amz-Security-Token')).toBe('tok/en+=');
        expect(url.search).toContain('X-Amz-Security-Token=tok%2Fen%2B%3D');
    });

    it('refuses an expiry past 7 days or under a second', () => {
        expect(() => presignUrl({ ...input, expiresSeconds: 604_801 })).toThrow();
        expect(() => presignUrl({ ...input, expiresSeconds: 0 })).toThrow();
    });
});

describe('SigV4 Authorization header (AWS S3 single-chunk examples)', () => {
    const base = { origin: ORIGIN, region: 'us-east-1', credentials: S3_EXAMPLE, now: NOW };
    const sigOf = (h: Record<string, string>) => /Signature=([0-9a-f]{64})$/.exec(h.authorization)?.[1];

    it('GET Object with a Range header', () => {
        const r = signRequest({ ...base, method: 'GET', path: '/test.txt', headers: { Range: 'bytes=0-9' }, payloadHash: EMPTY_SHA256 });
        expect(r.headers.authorization).toBe(
            'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
        );
        expect(r.headers['x-amz-date']).toBe('20130524T000000Z');
    });

    it('PUT Object with a key that needs encoding ($)', () => {
        const body = 'Welcome to Amazon S3.';
        expect(sha256Hex(body)).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
        const r = signRequest({
            ...base,
            method: 'PUT',
            path: '/test$file.text',
            headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
            payloadHash: sha256Hex(body),
        });
        expect(r.url).toBe('https://examplebucket.s3.amazonaws.com/test%24file.text');
        expect(sigOf(r.headers)).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
    });

    it('GET Bucket Lifecycle (?lifecycle, an empty value)', () => {
        const r = signRequest({ ...base, method: 'GET', path: '/', query: { lifecycle: '' }, payloadHash: EMPTY_SHA256 });
        expect(sigOf(r.headers)).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
    });

    it('GET Bucket (List Objects), query sorted by name', () => {
        const r = signRequest({ ...base, method: 'GET', path: '/', query: [['prefix', 'J'], ['max-keys', '2']], payloadHash: EMPTY_SHA256 });
        expect(sigOf(r.headers)).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
        expect(r.url).toBe('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J');
    });
});

describe('SigV4 test suite: get-vanilla', () => {
    it('matches the suite signature', () => {
        const r = signRequest({
            method: 'GET',
            origin: 'https://example.amazonaws.com',
            path: '/',
            region: 'us-east-1',
            service: 'service',
            credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
            now: new Date('2015-08-30T12:36:00Z'),
            payloadHash: EMPTY_SHA256,
        });
        expect(r.headers.authorization).toBe(
            'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
        );
    });
});

describe('uriEncode', () => {
    it('keeps only the unreserved set, UTF-8 bytes in uppercase hex', () => {
        expect(uriEncode('a b/c~d.e_f-g')).toBe('a%20b%2Fc~d.e_f-g');
        expect(uriEncode('a b/c', true)).toBe('a%20b/c');
        expect(uriEncode('é*')).toBe('%C3%A9%2A');
    });
});

import { createPublicKey, generateKeyPairSync, verify } from 'crypto';

import { ImageStoreConfigSchema } from './image-store';
import { IMAGE_STORE_TOKEN_ISSUER, libtrustKeyId, OciRegistryImageStore } from './image-store-oci';
import { describeImageStoreConformance } from './testing';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const config = ImageStoreConfigSchema.parse({ provider: 'oci-registry', endpoint: 'https://store.example/', service: 'svc' });
const now = new Date('2026-11-27T12:00:00.000Z');

const decode = (token: string) => {
    const [h, p, s] = token.split('.');
    return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), payload: JSON.parse(Buffer.from(p, 'base64url').toString()), signed: `${h}.${p}`, sig: Buffer.from(s, 'base64url') };
};

describeImageStoreConformance('oci-registry', () => {
    const provider = new OciRegistryImageStore(pem);
    return {
        provider,
        config,
        namedBy: (g) => decode(g.token).payload.access.map((a: { name: string; actions: string[] }) => ({ name: a.name, pull: a.actions.includes('pull'), push: a.actions.includes('push') })),
    };
});

describe('the oci-registry token', () => {
    const grant = () => new OciRegistryImageStore(pem).grant(config, { claimId: 'claim-1', organizationId: 'o', repos: [{ scope: 'pr', name: 'p/o-a/e-b/pr-c', pull: true, push: true }], ttlSeconds: 600 }, now);

    // The registry verifies the signature with the public key of its certificate bundle.
    it('is signed with the hub key, so a registry that trusts the public key accepts it and nothing else does', async () => {
        const t = decode((await grant()).token);
        expect(verify('sha256', Buffer.from(t.signed), { key: publicKey, dsaEncoding: 'ieee-p1363' }, t.sig)).toBe(true);
        const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
        expect(verify('sha256', Buffer.from(t.signed), { key: other, dsaEncoding: 'ieee-p1363' }, t.sig)).toBe(false);
    });

    it('names the issuer, the service as audience, the claim as subject, and expires with the grant', async () => {
        const g = await grant();
        const { payload } = decode(g.token);
        expect(payload).toMatchObject({ iss: IMAGE_STORE_TOKEN_ISSUER, aud: 'svc', sub: 'claim-1', exp: Math.floor(now.getTime() / 1000) + 600 });
        expect(new Date(payload.exp * 1000).toISOString()).toBe(g.expiresAt);
    });

    it('carries the key id the registry looks the key up by, 12 groups of 4 base32 characters', async () => {
        const { header } = decode((await grant()).token);
        expect(header).toMatchObject({ typ: 'JWT', alg: 'ES256' });
        expect(header.kid).toMatch(/^([A-Z2-7]{4}:){11}[A-Z2-7]{4}$/);
        expect(header.kid).toBe(libtrustKeyId(createPublicKey(privateKey)));
    });

    it('trims a trailing slash of the endpoint, so the cell builds the same URLs the registry serves', async () => {
        expect((await grant()).endpoint).toBe('https://store.example');
    });

    it('refuses a key that is not EC P-256, so a wrong key fails at boot and not at the first claim', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        expect(() => new OciRegistryImageStore(rsa)).toThrow(/P-256/);
    });
});

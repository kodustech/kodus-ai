import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from 'crypto';

import type { GrantRequest, ImageStoreConfig, ImageStoreProvider, StoreEndpoint, StoreGrant } from './image-store';

// The `oci-registry` provider (docs/runtime/shared-image-store.md section 3): an OCI distribution registry (CNCF
// distribution, zot) that trusts the hub's public key. The hub is the token service in Docker's token-auth scheme:
// instead of answering a challenge, it hands the cell the signed bearer token with the claim, and the registry
// checks the signature, the audience and the expiry. Nothing here does I/O.

/** The `iss` the registry's `auth.token.issuer` is set to. */
export const IMAGE_STORE_TOKEN_ISSUER = 'kodus-runtime-hub';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * distribution's key id (libtrust): the SHA-256 of the key's SPKI DER, cut to 30 bytes, base32, in 12 groups of 4
 * joined by `:`. The registry looks up the token's `kid` header among the keys of its trusted certificate bundle.
 */
export function libtrustKeyId(publicKey: KeyObject): string {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const sum = createHash('sha256').update(der).digest().subarray(0, 30);
    let bits = 0;
    let acc = 0;
    let out = '';
    for (const byte of sum) {
        acc = (acc << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(acc >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    return out.match(/.{4}/g)!.join(':');
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** An ES256 JWT in the shape distribution reads: `access` names repositories and the actions allowed on each. */
export function signRegistryToken(key: KeyObject, claims: { service: string; subject: string; access: Array<{ name: string; actions: string[] }>; now: Date; ttlSeconds: number }): string {
    const iat = Math.floor(claims.now.getTime() / 1000);
    const header = { typ: 'JWT', alg: 'ES256', kid: libtrustKeyId(createPublicKey(key)) };
    const payload = {
        iss: IMAGE_STORE_TOKEN_ISSUER,
        sub: claims.subject,
        aud: claims.service,
        exp: iat + claims.ttlSeconds,
        nbf: iat - 5,
        iat,
        jti: randomUUID(),
        access: claims.access.map((a) => ({ type: 'repository', name: a.name, actions: a.actions })),
    };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    return `${input}.${b64url(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`;
}

export class OciRegistryImageStore implements ImageStoreProvider {
    readonly kind = 'oci-registry' as const;
    private readonly key: KeyObject;

    /** `signingKeyPem`: the hub's EC P-256 private key (PKCS#8 or SEC1 PEM). Its certificate is the registry's `rootcertbundle`. */
    constructor(signingKeyPem: string) {
        this.key = createPrivateKey(signingKeyPem);
        if (this.key.asymmetricKeyType !== 'ec' || this.key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('the image store signing key must be an EC P-256 key');
    }

    endpointFor(config: ImageStoreConfig): StoreEndpoint {
        if (config.provider !== 'oci-registry') throw new Error(`the oci-registry provider cannot serve a ${config.provider} config`);
        return { endpoint: config.endpoint.replace(/\/+$/, ''), prefix: config.prefix };
    }

    async grant(config: ImageStoreConfig, req: GrantRequest, now: Date): Promise<StoreGrant> {
        if (config.provider !== 'oci-registry') throw new Error(`the oci-registry provider cannot serve a ${config.provider} config`);
        if (req.repos.length === 0) throw new Error('a grant names at least one repository');
        // A registry needs pull on a repository to push into it (a blob mount and the manifest check read first).
        const access = req.repos.map((r) => ({ name: r.name, actions: [...(r.pull || r.push ? ['pull'] : []), ...(r.push ? ['push'] : [])] }));
        const token = signRegistryToken(this.key, { service: config.service, subject: req.claimId, access, now, ttlSeconds: req.ttlSeconds });
        return { ...this.endpointFor(config), token, expiresAt: new Date(now.getTime() + req.ttlSeconds * 1000).toISOString(), repos: req.repos.map((r) => ({ ...r })) };
    }

    /** A registry validates a signature and keeps no denylist: the token ends at its expiry, and the hub stops renewing it. */
    async revoke(): Promise<void> {}
}

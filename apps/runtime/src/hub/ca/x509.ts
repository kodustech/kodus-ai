import { createPublicKey, generateKeyPairSync, KeyObject, randomBytes, sign, verify, X509Certificate } from 'crypto';

// The hub's internal CA (ADR-054). node_modules has no X.509 library, so the
// short client certificate is built here: a minimal DER writer for the
// TBSCertificate and a DER reader for the CSR, signed with crypto.sign.
// Only what the CA needs: ECDSA P-256 / SHA-256 (the cells and the dev CA use
// P-256), v3 with basicConstraints, keyUsage and extKeyUsage.

// ---------- DER ----------

type Node = { tag: number; header: number; len: number; start: number; end: number; raw: Buffer; body: Buffer };

function readNode(buf: Buffer, at: number): Node {
    if (!Number.isInteger(at) || at < 0 || at + 2 > buf.length) throw new Error('der: truncated');
    const tag = buf[at];
    let len = buf[at + 1];
    let header = 2;
    if (len & 0x80) {
        const n = len & 0x7f;
        if (n < 1 || n > 4) throw new Error('der: bad length');
        if (at + 2 + n > buf.length) throw new Error('der: truncated');
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i];
        header += n;
    }
    const end = at + header + len;
    if (!Number.isInteger(end) || end > buf.length) throw new Error('der: truncated');
    return { tag, header, len, start: at, end, raw: buf.subarray(at, end), body: buf.subarray(at + header, end) };
}

function children(n: Node): Node[] {
    const out: Node[] = [];
    for (let at = 0; at < n.body.length; ) {
        const c = readNode(n.body, at);
        out.push(c);
        at = c.end;
    }
    return out;
}

function len(n: number): Buffer {
    if (n < 0x80) return Buffer.from([n]);
    const bytes: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const explicit = (n: number, ...p: Buffer[]) => tlv(0xa0 + n, ...p);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octets = (b: Buffer) => tlv(0x04, b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));

function integer(b: Buffer): Buffer {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return tlv(0x02, v);
}

function bitString(b: Buffer, unused = 0) {
    return tlv(0x03, Buffer.from([unused]), b);
}

function oid(dotted: string): Buffer {
    const p = dotted.split('.').map(Number);
    const out = [40 * p[0] + p[1]];
    for (const n of p.slice(2)) {
        const bytes = [n & 0x7f];
        for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) bytes.unshift(0x80 | (v & 0x7f));
        out.push(...bytes);
    }
    return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
    const iso = d.toISOString();
    const y = d.getUTCFullYear();
    const compact = iso.slice(0, 19).replace(/[-:T]/g, '') + 'Z';
    // UTCTime until 2049, GeneralizedTime after (RFC 5280 §4.1.2.5).
    return y < 2050 ? tlv(0x17, Buffer.from(compact.slice(2))) : tlv(0x18, Buffer.from(compact));
}

const OID = {
    ecdsaSha256: '1.2.840.10045.4.3.2',
    cn: '2.5.4.3',
    ou: '2.5.4.11',
    o: '2.5.4.10',
    basicConstraints: '2.5.29.19',
    keyUsage: '2.5.29.15',
    extKeyUsage: '2.5.29.37',
    clientAuth: '1.3.6.1.5.5.7.3.2',
};

const name = (attrs: Array<[string, string]>) => seq(...attrs.map(([o, v]) => set(seq(oid(o), utf8(v)))));
const ext = (o: string, critical: boolean, value: Buffer) => seq(oid(o), ...(critical ? [bool(true)] : []), octets(value));

const pem = (label: string, der: Buffer) => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`;

export function pemToDer(text: string, label: string): Buffer {
    const m = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`).exec(text);
    if (!m) throw new Error(`pem: no ${label}`);
    return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
}

// ---------- CSR ----------

/** Reads a PKCS#10 CSR and checks its self-signature. Returns its public key (SPKI DER). */
export function parseCsr(csrPem: string): { spki: Buffer; publicKey: KeyObject } {
    const der = pemToDer(csrPem, 'CERTIFICATE REQUEST');
    if (der.length > 8_192) throw new Error('csr: too large');
    const top = readNode(der, 0);
    if (top.tag !== 0x30 || top.end !== der.length) throw new Error('csr: not a sequence');
    const [info, alg, sig] = children(top);
    if (!info || !alg || !sig || sig.tag !== 0x03) throw new Error('csr: malformed');
    const fields = children(info);
    const spkiNode = fields[2];
    if (!spkiNode || spkiNode.tag !== 0x30) throw new Error('csr: no public key');
    const publicKey = createPublicKey({ key: spkiNode.raw, format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('csr: key must be ECDSA P-256');
    const algOid = children(alg)[0];
    if (!algOid || !algOid.raw.equals(oid(OID.ecdsaSha256))) throw new Error('csr: signature must be ecdsa-with-SHA256');
    if (!verify('sha256', info.raw, { key: publicKey, dsaEncoding: 'der' }, sig.body.subarray(1))) throw new Error('csr: bad signature');
    return { spki: Buffer.from(spkiNode.raw), publicKey };
}

// ---------- certificate ----------

export interface CaMaterial {
    certPem: string;
    keyPem: string;
}

export interface IssuedCert {
    certPem: string;
    serial: string; // upper-case hex, as X509Certificate.serialNumber prints it
    notAfter: Date;
}

/** The CA certificate's subject, as DER, to use as the issuer of what it signs. */
function caSubject(caCertPem: string): Buffer {
    const top = readNode(pemToDer(caCertPem, 'CERTIFICATE'), 0);
    const tbs = children(top)[0];
    const f = children(tbs);
    const off = f[0].tag === 0xa0 ? 1 : 0;
    return Buffer.from(f[off + 4].raw);
}

/**
 * Signs a client certificate: CN = commonName, OU = role (cell | worker),
 * clientAuth only, valid for `hours`. The serial is 16 random bytes.
 */
export function issueClientCert(ca: CaMaterial, spki: Buffer, opts: { commonName: string; role: 'cell' | 'worker'; hours: number; now?: Date }): IssuedCert {
    const now = opts.now ?? new Date();
    const serialBytes = randomBytes(16);
    serialBytes[0] &= 0x7f;
    if (serialBytes[0] === 0) serialBytes[0] = 1;
    const notBefore = new Date(now.getTime() - 5 * 60_000);
    const notAfter = new Date(now.getTime() + opts.hours * 3_600_000);
    const tbs = seq(
        explicit(0, integer(Buffer.from([2]))),
        integer(serialBytes),
        seq(oid(OID.ecdsaSha256)),
        caSubject(ca.certPem),
        seq(time(notBefore), time(notAfter)),
        name([
            [OID.o, 'kodus-runtime'],
            [OID.ou, opts.role],
            [OID.cn, opts.commonName],
        ]),
        spki,
        explicit(
            3,
            seq(
                ext(OID.basicConstraints, true, seq()),
                // digitalSignature only.
                ext(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)),
                ext(OID.extKeyUsage, false, seq(oid(OID.clientAuth))),
            ),
        ),
    );
    const signature = sign('sha256', tbs, { key: ca.keyPem, dsaEncoding: 'der' });
    const der = seq(tbs, seq(oid(OID.ecdsaSha256)), bitString(signature));
    const certPem = pem('CERTIFICATE', der);
    const x = new X509Certificate(certPem);
    // What was built here is checked by Node's own X.509 parser before it leaves the CA.
    const caCert = new X509Certificate(ca.certPem);
    if (!x.checkIssued(caCert) || !x.verify(caCert.publicKey)) throw new Error('ca: the issued certificate does not verify against the CA');
    return { certPem, serial: normalizeSerial(x.serialNumber), notAfter };
}

/** A self-signed P-256 CA (tests and a hub started without RUNTIME_TLS_CA). */
export function createCa(commonName: string, days = 365, now = new Date()): CaMaterial {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const subject = name([
        [OID.o, 'kodus-runtime'],
        [OID.cn, commonName],
    ]);
    const tbs = seq(
        explicit(0, integer(Buffer.from([2]))),
        integer(randomBytes(16).fill(1, 0, 1)),
        seq(oid(OID.ecdsaSha256)),
        subject,
        seq(time(new Date(now.getTime() - 5 * 60_000)), time(new Date(now.getTime() + days * 86_400_000))),
        subject,
        publicKey.export({ format: 'der', type: 'spki' }),
        explicit(
            3,
            seq(
                ext(OID.basicConstraints, true, seq(bool(true), integer(Buffer.from([0])))),
                // keyCertSign + cRLSign.
                ext(OID.keyUsage, true, bitString(Buffer.from([0x06]), 1)),
            ),
        ),
    );
    const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
    return {
        certPem: pem('CERTIFICATE', seq(tbs, seq(oid(OID.ecdsaSha256)), bitString(signature))),
        keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    };
}

/** A PKCS#10 CSR for a P-256 key (the TS fake cell and tests; the Go cell builds its own). */
export function createCsr(key: KeyObject, commonName = 'pending'): string {
    const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
    const info = seq(integer(Buffer.from([0])), name([[OID.cn, commonName]]), spki, Buffer.from([0xa0, 0x00]));
    const signature = sign('sha256', info, { key, dsaEncoding: 'der' });
    return pem('CERTIFICATE REQUEST', seq(info, seq(oid(OID.ecdsaSha256)), bitString(signature)));
}

/** Upper-case hex without leading zeros: Node and openssl print serials differently. */
export const normalizeSerial = (s: string) => s.replace(/[^0-9a-f]/gi, '').replace(/^0+(?=.)/, '').toUpperCase();

export { peerIdentity } from '../../shared/identity/tls-identity';

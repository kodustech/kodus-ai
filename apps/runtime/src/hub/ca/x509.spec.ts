import { execFileSync } from 'child_process';
import { generateKeyPairSync, X509Certificate } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createCa, createCsr, issueClientCert, normalizeSerial, parseCsr } from './x509';

const hasOpenssl = (() => {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

describe('hub CA (hand-written DER)', () => {
    const ca = createCa('test CA');
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;

    it('issues a 24 h client certificate that chains to the CA with CN = cellId', () => {
        const { spki } = parseCsr(createCsr(key));
        const now = new Date();
        const issued = issueClientCert(ca, spki, { commonName: 'cell-abc', role: 'cell', hours: 24, now });
        const x = new X509Certificate(issued.certPem);
        const caX = new X509Certificate(ca.certPem);
        expect(x.verify(caX.publicKey)).toBe(true);
        expect(x.checkIssued(caX)).toBe(true);
        expect(x.subject).toContain('CN=cell-abc');
        expect(x.subject).toContain('OU=cell');
        expect(x.ca).toBe(false);
        expect(x.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
        expect(Date.parse(x.validTo) - now.getTime()).toBeLessThanOrEqual(24 * 3_600_000);
        expect(Date.parse(x.validTo) - now.getTime()).toBeGreaterThan(23 * 3_600_000);
        expect(normalizeSerial(x.serialNumber)).toBe(issued.serial);
        expect(x.checkPrivateKey(key)).toBe(true);
    });

    it('refuses a CSR whose signature does not match its key', () => {
        const csr = createCsr(key);
        const other = createCsr(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey);
        // Graft the other CSR's signature onto this one.
        const b = (p: string) => Buffer.from(p.replace(/-----[^-]+-----|\s/g, ''), 'base64');
        const a = b(csr);
        const o = b(other);
        const forged = Buffer.concat([a.subarray(0, a.length - 72), o.subarray(o.length - 72)]);
        expect(() => parseCsr(`-----BEGIN CERTIFICATE REQUEST-----\n${forged.toString('base64')}\n-----END CERTIFICATE REQUEST-----`)).toThrow();
    });

    it('refuses a non P-256 key', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
        expect(() => parseCsr(createCsr(rsa))).toThrow();
    });

    (hasOpenssl ? it : it.skip)('openssl verifies the chain and reads the CSR', () => {
        const dir = mkdtempSync(join(tmpdir(), 'kr-ca-'));
        try {
            const csr = createCsr(key);
            const issued = issueClientCert(ca, parseCsr(csr).spki, { commonName: 'cell-xyz', role: 'cell', hours: 24 });
            writeFileSync(join(dir, 'ca.pem'), ca.certPem);
            writeFileSync(join(dir, 'cell.pem'), issued.certPem);
            writeFileSync(join(dir, 'cell.csr'), csr);
            const out = execFileSync('openssl', ['verify', '-purpose', 'sslclient', '-CAfile', join(dir, 'ca.pem'), join(dir, 'cell.pem')]).toString();
            expect(out).toContain(': OK');
            execFileSync('openssl', ['req', '-in', join(dir, 'cell.csr'), '-noout', '-verify'], { stdio: 'ignore' });
            const serial = execFileSync('openssl', ['x509', '-in', join(dir, 'cell.pem'), '-noout', '-serial']).toString().split('=')[1];
            expect(normalizeSerial(serial)).toBe(issued.serial);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('refuses a truncated or cut CSR at every length, never reading past the buffer', () => {
        const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
        const der = Buffer.from(createCsr(key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
        for (const n of [0, 1, 2, 3, 10, der.length - 1]) {
            const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${der.subarray(0, n).toString('base64')}\n-----END CERTIFICATE REQUEST-----\n`;
            expect(() => parseCsr(pem)).toThrow();
        }
    });

    it('refuses to hand out a certificate that does not verify against the CA it claims', () => {
        const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const { spki } = parseCsr(createCsr(key.privateKey));
        const ca = createCa('real CA');
        const other = createCa('another CA');
        // The subject of one CA, signed with the key of another: Node's parser rejects it.
        expect(() => issueClientCert({ certPem: ca.certPem, keyPem: other.keyPem }, spki, { commonName: 'cell-x', role: 'cell', hours: 1 })).toThrow(/does not verify/);
    });
});


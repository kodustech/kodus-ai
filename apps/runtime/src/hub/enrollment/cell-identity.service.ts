import { createHash, randomUUID, timingSafeEqual } from 'crypto';

import { CaMaterial, IssuedCert, issueClientCert, normalizeSerial, parseCsr } from '../ca/x509';
import type { CellRegistryRepository } from '../hub-store';
import type { CellCredential, HubLog, HubMetrics, IssuedIdentity, PeerCert } from '../hub-types';

// Who a cell is (ADR-054): enrollment with a single-use token and a CSR, the
// 24 h certificate renewals, and the per-replica cache of pinned and revoked
// serials the TLS handshake checks synchronously.

/** Short client certificates (ADR-054). */
export const CELL_CERT_HOURS = 24;

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHash = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

export class CellIdentityService {
    /** Newest pinned serial per cell, and serials known revoked: the synchronous check at the TLS handshake. */
    private readonly pinnedSerialByCell = new Map<string, string>();
    private readonly revokedSerials = new Set<string>();
    /** Until the first reload a replica knows no revocation: it refuses every client certificate. */
    private pinsLoaded = false;

    constructor(
        private readonly registry: CellRegistryRepository,
        private readonly ca: CaMaterial,
        private readonly hubMetrics: HubMetrics,
        private readonly log: HubLog,
        private readonly now: () => Date,
    ) {}

    /**
     * Called at secureConnection, before any byte of HTTP is read: a client
     * certificate that is presented must chain to the CA, must not be a known
     * revoked serial and, when the cell's pin is known, must be the pinned one.
     * No certificate is fine here (only /cells/register and /health take that).
     * The cache is per replica and reloaded every 5 s; every route re-reads
     * the row (authenticateCell). A fresh replica fails closed until its first load.
     */
    handshakeAllowed(peer: PeerCert & { presented: boolean }): boolean {
        if (!peer.presented) return true;
        if (!this.pinsLoaded) return false;
        if (!peer.authorized || !peer.serial) return false;
        const serial = normalizeSerial(peer.serial);
        if (this.revokedSerials.has(serial)) return false;
        if (peer.role === 'cell' && peer.cn) {
            const pinned = this.pinnedSerialByCell.get(peer.cn);
            if (pinned && pinned !== serial) return false;
        }
        return true;
    }

    /** Reloads the pins and the revoked serials from the store (every replica polls it). */
    async reloadCertificatePins(): Promise<void> {
        const rows = await this.registry.cellPins();
        const known = new Set<string>();
        for (const p of rows) {
            known.add(p.cellId);
            if (p.status === 'revoked') {
                this.pinnedSerialByCell.delete(p.cellId);
                if (p.serial) this.revokedSerials.add(p.serial);
            } else if (p.serial) this.pinnedSerialByCell.set(p.cellId, p.serial);
        }
        // A cell whose row is gone has no pin any more.
        for (const cellId of [...this.pinnedSerialByCell.keys()]) if (!known.has(cellId)) this.pinnedSerialByCell.delete(cellId);
        this.pinsLoaded = true;
    }

    /**
     * The only way a cell is authenticated (ADR-054): a client certificate from
     * the hub CA with OU=cell and CN=cellId, whose serial is the newest one
     * pinned on the cell's runtime_cells row, not revoked and not expired.
     */
    async authenticateCell(peer: PeerCert): Promise<CellCredential | null> {
        if (!peer.authorized || peer.role !== 'cell' || !peer.cn || !peer.serial) return null;
        const cell = await this.registry.registeredCell(peer.cn);
        if (!cell || cell.status === 'revoked' || !cell.certificateSerial) return null;
        if (!sameHash(cell.certificateSerial, normalizeSerial(peer.serial))) return null;
        if (Date.parse(cell.certificateExpiresAt) <= this.now().getTime()) return null;
        return { cellId: cell.cellId, owner: cell.owner, orgId: cell.organizationId ?? undefined };
    }

    private issue(cellId: string, csrPem: string) {
        const { spki } = parseCsr(csrPem);
        return issueClientCert(this.ca, spki, { commonName: cellId, role: 'cell', hours: CELL_CERT_HOURS, now: this.now() });
    }

    /**
     * Redeems a single-use dashboard token and signs the cell's CSR: CN = the
     * new cellId, 24 h. The CSR is checked and the certificate signed before the
     * token is spent; the token and the cell row commit together.
     */
    async register(token: string, topology: string, csrPem: string): Promise<IssuedIdentity | { ok: false; reason: string }> {
        const cellId = `cell-${randomUUID()}`;
        let cert: IssuedCert;
        try {
            cert = this.issue(cellId, csrPem);
        } catch (e) {
            return { ok: false, reason: (e as Error).message };
        }
        const r = await this.registry.redeemAndRegister(token, topology, (redeemed) => ({
            cellId,
            organizationId: redeemed.organizationId,
            owner: 'customer',
            topology: redeemed.topology,
            status: 'disconnected',
            certificateSerial: cert.serial,
            certificateExpiresAt: cert.notAfter.toISOString(),
        }));
        if (r.ok === false) return { ok: false, reason: r.reason };
        this.pinnedSerialByCell.set(cellId, cert.serial);
        this.log('info', 'cell.registered', { cellId, orgId: r.organizationId, topology: r.topology });
        return { ok: true, cellId, certificate: cert.certPem, caCertificate: this.ca.certPem, expiresAt: cert.notAfter.toISOString(), serial: cert.serial };
    }

    /** A connected cell trades its valid certificate for a new one; the pin moves to the new serial. */
    async renew(cred: CellCredential, csrPem: string): Promise<IssuedIdentity | { ok: false; reason: string }> {
        let cert: IssuedCert;
        try {
            cert = this.issue(cred.cellId, csrPem);
        } catch (e) {
            return { ok: false, reason: (e as Error).message };
        }
        if (!(await this.registry.pinCertificate(cred.cellId, cert.serial, cert.notAfter.toISOString()))) return { ok: false, reason: 'revoked' };
        this.pinnedSerialByCell.set(cred.cellId, cert.serial);
        return { ok: true, cellId: cred.cellId, certificate: cert.certPem, caCertificate: this.ca.certPem, expiresAt: cert.notAfter.toISOString(), serial: cert.serial };
    }

    /**
     * Managed cells listed in config (cellId → serial of a certificate the CA
     * signed out of band, e.g. scripts/runtime/dev-ca.sh) get a runtime_cells
     * row, so every cell is revoked through its row.
     */
    async ensureManagedCells(cells: Record<string, string>, expiresAt: string): Promise<void> {
        for (const [cellId, serial] of Object.entries(cells)) {
            await this.registry.upsertManagedCell({ cellId, certificateSerial: normalizeSerial(serial), certificateExpiresAt: expiresAt });
        }
        await this.reloadCertificatePins();
    }

    /** Of the cells this replica holds, those revoked since; the pin cache is reloaded first. */
    async revokedAmong(cellIds: string[]): Promise<string[]> {
        await this.reloadCertificatePins().catch((e) => {
            this.hubMetrics.backgroundError('pins_reload');
            this.log('error', 'cell.pins_reload_failed', { error: (e as Error).message });
        });
        return this.registry.filterRevoked(cellIds);
    }
}

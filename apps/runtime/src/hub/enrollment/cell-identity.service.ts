import { createHash, randomUUID, timingSafeEqual } from 'crypto';

import { isFleetToken } from '@libs/runtime/contracts/fleet-token';

import { CaMaterial, IssuedCert, issueClientCert, normalizeSerial, parseCsr } from '../ca/x509';
import type { CellRegistryRepository } from '../hub-store';
import type { CellCredential, HubLog, HubMetrics, IssuedIdentity, PeerCert } from '../hub-types';

// Who a cell is (ADR-054): enrollment with a single-use token and a CSR, the
// 24 h certificate renewals, and the per-replica cache of pinned and revoked
// serials the TLS handshake checks synchronously.

/** The topology of a cell a fleet token registered. */
export const FLEET_TOPOLOGY = 'fleet';

/** Short client certificates (ADR-054). */
export const CELL_CERT_HOURS = 24;

/** The one answer to a CSR the hub refuses: the parser's reason stays inside. */
export const INVALID_CSR = 'invalid_csr';

/** A CSR refused inside the token's redemption: thrown so the redemption rolls back. */
class CsrRefused extends Error {}

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

    /**
     * Replaces the pins and the revoked serials with what the store lists now (every replica polls it). The
     * store lists only cells whose certificate has not expired: an expired certificate fails the handshake
     * (`authorized` is false), so its serial needs no entry, and the set no longer grows with every cell a
     * perRun pool ever had. Swapped in one synchronous pass: no handshake sees a half-built set.
     */
    async reloadCertificatePins(): Promise<void> {
        const rows = await this.registry.cellPins();
        this.pinnedSerialByCell.clear();
        this.revokedSerials.clear();
        for (const p of rows) {
            if (p.status === 'revoked') {
                if (p.serial) this.revokedSerials.add(p.serial);
            } else if (p.serial) this.pinnedSerialByCell.set(p.cellId, p.serial);
        }
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
     * new cellId, 24 h. The token is checked first: the CSR is parsed and
     * signed only inside the redemption, so nobody without a good token makes
     * the hub read a CSR or use the CA key. A CSR that does not parse throws
     * out of the redemption, which rolls back and keeps the token; the token
     * and the cell row commit together. The caller learns only that the CSR
     * was refused, never the parser's words.
     */
    async register(token: string, topology: string | undefined, csrPem: string): Promise<IssuedIdentity | { ok: false; reason: string }> {
        // A fleet token makes a Kodus cell of its pool (docs/runtime/host-providers.md §8.1); an org token never does.
        if (isFleetToken(token)) return topology && topology !== FLEET_TOPOLOGY ? { ok: false, reason: 'topology_mismatch' } : this.registerFleetHost(token, csrPem);
        if (topology === FLEET_TOPOLOGY) return { ok: false, reason: 'topology_mismatch' };
        const cellId = `cell-${randomUUID()}`;
        let cert: IssuedCert | undefined;
        let r: Awaited<ReturnType<CellRegistryRepository['redeemAndRegister']>>;
        try {
            r = await this.registry.redeemAndRegister(token, topology, (redeemed) => {
                try {
                    cert = this.issue(cellId, csrPem);
                } catch {
                    throw new CsrRefused();
                }
                return {
                    cellId,
                    organizationId: redeemed.organizationId,
                    owner: 'customer',
                    topology: redeemed.topology,
                    status: 'disconnected',
                    certificateSerial: cert.serial,
                    certificateExpiresAt: cert.notAfter.toISOString(),
                };
            });
        } catch (e) {
            if (e instanceof CsrRefused) return { ok: false, reason: INVALID_CSR };
            throw e;
        }
        if (r.ok === false) return { ok: false, reason: r.reason };
        if (!cert) return { ok: false, reason: INVALID_CSR };
        this.pinnedSerialByCell.set(cellId, cert.serial);
        this.log('info', 'cell.registered', { cellId, orgId: r.organizationId, topology: r.topology });
        return { ok: true, cellId, certificate: cert.certPem, caCertificate: this.ca.certPem, expiresAt: cert.notAfter.toISOString(), serial: cert.serial };
    }

    /**
     * A fleet host's cell (§8.1): the kcf_ token binds its pool, host and Run, the cell is Kodus's and no org's.
     * As for an org token, the CSR is read and signed only inside the redemption.
     */
    private async registerFleetHost(token: string, csrPem: string): Promise<IssuedIdentity | { ok: false; reason: string }> {
        const cellId = `cell-${randomUUID()}`;
        let cert: IssuedCert | undefined;
        let r: Awaited<ReturnType<CellRegistryRepository['redeemFleetAndRegister']>>;
        try {
            r = await this.registry.redeemFleetAndRegister(token, (redeemed) => {
                try {
                    cert = this.issue(cellId, csrPem);
                } catch {
                    throw new CsrRefused();
                }
                return {
                    cellId,
                    organizationId: null,
                    owner: 'kodus',
                    topology: FLEET_TOPOLOGY,
                    status: 'disconnected',
                    certificateSerial: cert.serial,
                    certificateExpiresAt: cert.notAfter.toISOString(),
                    poolId: redeemed.poolId,
                    hostId: redeemed.hostId,
                    boundKey: redeemed.boundKey,
                };
            });
        } catch (e) {
            if (e instanceof CsrRefused) return { ok: false, reason: INVALID_CSR };
            throw e;
        }
        if (r.ok === false) return { ok: false, reason: r.reason };
        if (!cert) return { ok: false, reason: INVALID_CSR };
        this.pinnedSerialByCell.set(cellId, cert.serial);
        this.log('info', 'cell.registered', { cellId, topology: FLEET_TOPOLOGY, poolId: r.poolId, hostId: r.hostId });
        return { ok: true, cellId, certificate: cert.certPem, caCertificate: this.ca.certPem, expiresAt: cert.notAfter.toISOString(), serial: cert.serial };
    }

    /** A connected cell trades its valid certificate for a new one; the pin moves to the new serial. */
    async renew(cred: CellCredential, csrPem: string): Promise<IssuedIdentity | { ok: false; reason: string }> {
        let cert: IssuedCert;
        try {
            cert = this.issue(cred.cellId, csrPem);
        } catch {
            return { ok: false, reason: INVALID_CSR };
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

    /**
     * Of the cells this replica holds, those whose certificate expired and was not renewed: a certificate is
     * checked at the upgrade, so without this an open session would outlive it (ADR-054's 24 h certificate).
     */
    expiredAmong(cellIds: string[]): Promise<string[]> {
        return this.registry.filterExpired(cellIds, this.now().toISOString());
    }
}

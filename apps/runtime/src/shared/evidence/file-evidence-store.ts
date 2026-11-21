import { promises as fs } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';

import { evidenceKey, evidenceOrganizationPrefix, InvalidEvidenceKeyError } from '@libs/runtime/contracts/evidence';

// The evidence object store on a local volume (§8, self-hosted and dev): one
// file per key {orgId}/{runId}/{side}/{stepId}/{type}, 0600 under 0700
// directories, kept 30 days (§11). The key is always rebuilt from its parts
// with evidenceKey, so a path from anywhere else never reaches the disk.

export const EVIDENCE_RETENTION_DAYS = 30;

export interface EvidenceObject {
    body: Buffer;
    contentType: string;
}

/** Where a Run step's evidence goes; the worker writes, the evidence server reads. */
export interface EvidenceStore {
    put(key: string, body: string | Buffer, contentType: string): Promise<void>;
    get(key: string): Promise<EvidenceObject | null>;
    /**
     * A store where cells upload beside the evidence key (S3: a staging key)
     * hands the worker the upload to check, and the worker commits it to the
     * evidence key. Absent: the upload landed on the key itself, once (the
     * evidence server checks the grant), and `get` reads it.
     */
    takeUpload?(key: string, limit: { contentType: string; maxBytes: number }, opts: { read: boolean }): Promise<TakenUpload | null>;
    /**
     * Deletes every object under an organization's prefix (`{orgId}/`), or one Run's (`{orgId}/{runId}/`), and returns
     * how many objects went. Idempotent: nothing under the prefix returns 0. The data lifecycle's purge of an
     * organization; never a prefix that is not canonical (`canonicalEvidencePrefix`), so no empty or wide one.
     */
    deletePrefix(prefix: string): Promise<number>;
}

/** A cell's upload of one key that passed the store's type and size check. */
export interface TakenUpload {
    contentType: string;
    bytes: number;
    /** Only when asked to read. */
    body?: Buffer;
    /** A retried take of an upload committed redacted: the canary was already found (the Run must still halt). */
    redacted?: boolean;
    /** Makes it the evidence key's object: as uploaded, or `replacement` (a redacted text). Idempotent. */
    commit(replacement?: Buffer): Promise<void>;
}

const META = '.meta.json';

/** A path that is not there (not created yet, or removed by a concurrent sweep) reads as `fallback`; any other error propagates. */
const ifMissing =
    <T>(fallback: T) =>
    (e: unknown): T => {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback;
        throw e;
    };

/** The exact key, or InvalidEvidenceKeyError: five parts, each from its closed set. */
export function canonicalEvidenceKey(key: string): string {
    const parts = String(key ?? '').split('/');
    if (parts.length !== 5) throw new InvalidEvidenceKeyError('evidence key has five parts');
    const [organizationId, runId, side, stepId, type] = parts;
    const canonical = evidenceKey({ organizationId, runId, side, stepId, type });
    if (canonical !== key) throw new InvalidEvidenceKeyError('evidence key is not canonical');
    return canonical;
}

/** `{orgId}/` or `{orgId}/{runId}/`, or InvalidEvidenceKeyError: a prefix is built from the same parts as a key. */
export function canonicalEvidencePrefix(prefix: string): string {
    const parts = String(prefix ?? '').split('/');
    if (parts.length < 2 || parts.length > 3 || parts[parts.length - 1] !== '') throw new InvalidEvidenceKeyError('evidence prefix is an org or a Run, ending in a slash');
    const [organizationId, runId] = parts;
    const canonical = runId === undefined || runId === '' ? evidenceOrganizationPrefix(organizationId) : `${evidenceOrganizationPrefix(organizationId)}${evidenceOrganizationPrefix(runId)}`;
    if (canonical !== prefix) throw new InvalidEvidenceKeyError('evidence prefix is not canonical');
    return canonical;
}

export class FileEvidenceStore implements EvidenceStore {
    private readonly root: string;

    constructor(dir: string) {
        this.root = resolve(dir);
    }

    private path(key: string): string {
        const p = resolve(join(this.root, ...canonicalEvidenceKey(key).split('/')));
        const rel = relative(this.root, p);
        if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) throw new InvalidEvidenceKeyError('evidence key escapes the store');
        return p;
    }

    async put(key: string, body: string | Buffer, contentType: string): Promise<void> {
        const p = this.path(key);
        await fs.mkdir(dirname(p), { recursive: true, mode: 0o700 });
        const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, body, { mode: 0o600 });
        await fs.rename(tmp, p);
        await fs.writeFile(`${p}${META}`, JSON.stringify({ contentType }), { mode: 0o600 });
    }

    async get(key: string): Promise<EvidenceObject | null> {
        const p = this.path(key);
        try {
            // No meta yet (put writes it after the body) or an unreadable one: the body goes out as octet-stream, the safe type.
            const [body, meta] = await Promise.all([fs.readFile(p), fs.readFile(`${p}${META}`, 'utf8').catch(() => '{}')]);
            const contentType = (JSON.parse(meta) as { contentType?: string }).contentType ?? 'application/octet-stream';
            return { body, contentType };
        } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
            throw e;
        }
    }

    async deletePrefix(prefix: string): Promise<number> {
        const dir = resolve(join(this.root, ...canonicalEvidencePrefix(prefix).split('/').filter(Boolean)));
        const rel = relative(this.root, dir);
        if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) throw new InvalidEvidenceKeyError('evidence prefix escapes the store');
        // Objects are counted before the tree goes: a directory that is not there holds none.
        const count = async (d: string): Promise<number> => {
            let n = 0;
            for (const e of await fs.readdir(d, { withFileTypes: true }).catch(ifMissing([]))) {
                if (e.isDirectory()) n += await count(join(d, e.name));
                else if (!e.name.endsWith(META) && !e.name.endsWith('.tmp')) n++;
            }
            return n;
        };
        const removed = await count(dir);
        await fs.rm(dir, { recursive: true, force: true });
        return removed;
    }

    /** Deletes evidence older than the retention (and empty directories); returns how many objects went. */
    async sweep(now = new Date(), days = EVIDENCE_RETENTION_DAYS): Promise<number> {
        const cutoff = now.getTime() - days * 24 * 3_600_000;
        let removed = 0;
        const walk = async (dir: string): Promise<void> => {
            const entries = await fs.readdir(dir, { withFileTypes: true }).catch(ifMissing([]));
            for (const e of entries) {
                const p = join(dir, e.name);
                if (e.isDirectory()) {
                    await walk(p);
                } else if (!e.name.endsWith(META)) {
                    const st = await fs.stat(p).catch(ifMissing(null));
                    if (st && st.mtimeMs < cutoff) {
                        await fs.rm(p, { force: true });
                        await fs.rm(`${p}${META}`, { force: true });
                        if (!e.name.endsWith('.tmp')) removed++;
                    }
                }
            }
            // Only an empty directory is removed: one that cannot be listed is kept, and a put that raced in (ENOTEMPTY) keeps it too; the next sweep retries.
            if (dir !== this.root && (await fs.readdir(dir).catch(() => ['?'])).length === 0) await fs.rmdir(dir).catch(() => undefined);
        };
        await walk(this.root);
        return removed;
    }
}


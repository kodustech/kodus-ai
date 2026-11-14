import {
    evidenceObjectKey,
    evidenceStagingKey,
    presignEvidenceRead,
    presignEvidenceUpload,
    type S3EvidenceConfig,
} from '@libs/runtime/contracts/evidence-s3';
import type { EvidenceSide, EvidenceUploadType, UploadGrant } from '@libs/runtime/contracts/evidence';

import { canonicalEvidenceKey, type EvidenceObject, type EvidenceStore, type TakenUpload } from './file-evidence-store';
import { S3ObjectClient } from './s3-object-client';

// The evidence object store in an S3-compatible bucket (RUNTIME_EVIDENCE_STORE=s3,
// §8): no evidence on any process's disk, so every worker replica reads and
// writes the same objects. Retention is the bucket's lifecycle rule (30 days
// on the prefix, 1 day on its staging prefix), not a sweep (apps/runtime/README.md).
//
// A cell PUTs to the staging key with a presigned URL (content type signed);
// the worker takes it into the evidence key after checking it:
//   HEAD staging: absent, wrong type or past the type's bytes → dropped
//   (an oversized object is deleted unread);
//   a text the worker checks for canaries is read with If-Match on that ETag;
//   commit: a server-side copy pinned to that ETag (or a PUT of the redacted
//   text), then the staging object is deleted.
// A cell that PUTs again after the take changes nothing: the evidence key is
// written by the worker only, from the version it checked.

/** Presigns the grants and read URLs the worker hands a cell (run-evidence.ts). */
export interface EvidencePresigner {
    uploadGrant(input: { organizationId: string; runId: string; side: EvidenceSide; stepId: string; type: EvidenceUploadType; ttlSeconds: number; now?: Date }): UploadGrant;
    readUrl(key: string, ttlSeconds: number, now?: Date): string;
}

/** Set on an evidence object the worker stored redacted, so a retried take still reports the leak. */
const REDACTED_META = 'kody-redacted';

export class S3EvidenceStore implements EvidenceStore, EvidencePresigner {
    private readonly s3: S3ObjectClient;

    constructor(
        private readonly cfg: S3EvidenceConfig,
        client?: S3ObjectClient,
    ) {
        this.s3 = client ?? new S3ObjectClient(cfg);
    }

    async put(key: string, body: string | Buffer, contentType: string): Promise<void> {
        await this.s3.put(evidenceObjectKey(this.cfg, canonicalEvidenceKey(key)), Buffer.from(body), contentType);
    }

    async get(key: string): Promise<EvidenceObject | null> {
        const obj = await this.s3.get(evidenceObjectKey(this.cfg, canonicalEvidenceKey(key)));
        return obj ? { body: obj.body, contentType: obj.contentType } : null;
    }

    async takeUpload(key: string, limit: { contentType: string; maxBytes: number }, opts: { read: boolean }): Promise<TakenUpload | null> {
        const canonical = canonicalEvidenceKey(key);
        const staging = evidenceStagingKey(this.cfg, canonical);
        const target = evidenceObjectKey(this.cfg, canonical);
        const head = await this.s3.head(staging);
        if (!head) return this.alreadyTaken(target, limit, opts);
        if (head.contentType !== limit.contentType || head.contentLength > limit.maxBytes) {
            // Never read: a grant's PUT past its ceiling costs only its own staging object, removed here.
            await this.s3.delete(staging);
            return null;
        }
        let body: Buffer | undefined;
        if (opts.read) {
            const got = await this.s3.get(staging, { ifMatch: head.etag, maxBytes: limit.maxBytes });
            // Changed since the HEAD: the cell put twice; nothing of it is taken.
            if (!got) return null;
            body = got.body;
        }
        return {
            contentType: head.contentType,
            bytes: head.contentLength,
            ...(body ? { body } : {}),
            commit: async (replacement?: Buffer) => {
                if (replacement || body) {
                    await this.s3.put(target, replacement ?? body!, limit.contentType, replacement ? { [REDACTED_META]: '1' } : {});
                } else if (!(await this.s3.copy(staging, target, { contentType: limit.contentType, ifMatch: head.etag }))) {
                    throw new Error('evidence upload changed while it was taken');
                }
                await this.s3.delete(staging);
            },
        };
    }

    /** A retried take (the step ran again after its commit): the evidence key already holds it. */
    private async alreadyTaken(target: string, limit: { contentType: string; maxBytes: number }, opts: { read: boolean }): Promise<TakenUpload | null> {
        const head = await this.s3.head(target);
        if (!head) return null;
        const body = opts.read ? (await this.s3.get(target, { maxBytes: limit.maxBytes }))?.body : undefined;
        return {
            contentType: head.contentType,
            bytes: head.contentLength,
            ...(body ? { body } : {}),
            ...(head.meta[REDACTED_META] === '1' ? { redacted: true } : {}),
            commit: async (replacement?: Buffer) => {
                if (replacement) await this.s3.put(target, replacement, limit.contentType, { [REDACTED_META]: '1' });
            },
        };
    }

    uploadGrant(input: Parameters<EvidencePresigner['uploadGrant']>[0]): UploadGrant {
        return presignEvidenceUpload(this.cfg, input);
    }

    readUrl(key: string, ttlSeconds: number, now?: Date): string {
        return presignEvidenceRead(this.cfg, { key: canonicalEvidenceKey(key), ttlSeconds, now }).url;
    }
}

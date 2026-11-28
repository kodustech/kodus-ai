import { createHash } from 'crypto';

import { EMPTY_SHA256, sha256Hex, signRequest } from '@libs/runtime/contracts/sigv4';
import { EVIDENCE_S3_STAGING, s3ObjectLocation, type S3EvidenceConfig } from '@libs/runtime/contracts/evidence-s3';

// The few S3 calls the runtime-worker makes on its evidence bucket, signed
// with SigV4 (libs/runtime/contracts/sigv4.ts) over fetch: no SDK. Errors
// name the operation and the status only, never a URL, a key's signature or
// a credential.

export interface S3ObjectHead {
    contentLength: number;
    contentType: string;
    etag: string;
    /** x-amz-meta-* headers, names without the prefix. */
    meta: Record<string, string>;
}

export interface S3Object extends S3ObjectHead {
    body: Buffer;
}

export class S3RequestError extends Error {
    constructor(
        readonly op: string,
        readonly status: number,
        readonly code?: string,
    ) {
        super(`s3 ${op} failed: ${status}${code ? ` ${code}` : ''}`);
    }
}

type Fetch = typeof fetch;

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const codeOf = (xml: string) => /<Code>([^<]{1,64})<\/Code>/.exec(xml)?.[1];

export class S3ObjectClient {
    constructor(
        private readonly cfg: S3EvidenceConfig,
        private readonly opts: { fetch?: Fetch; timeoutMs?: number; now?: () => Date } = {},
    ) {}

    private async call(op: string, method: string, objectKey: string, init: { headers?: Record<string, string>; body?: Buffer; query?: Record<string, string> } = {}): Promise<Response> {
        const loc = s3ObjectLocation(this.cfg, objectKey);
        const signed = signRequest({
            method,
            ...loc,
            query: init.query,
            headers: init.headers,
            region: this.cfg.region,
            credentials: this.cfg.credentials,
            now: this.opts.now?.() ?? new Date(),
            payloadHash: init.body ? sha256Hex(init.body) : EMPTY_SHA256,
        });
        const res = await (this.opts.fetch ?? fetch)(signed.url, {
            method,
            headers: signed.headers,
            ...(init.body ? { body: new Uint8Array(init.body) } : {}),
            redirect: 'manual',
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        }).catch((e: Error) => {
            throw new S3RequestError(op, 0, e.name === 'TimeoutError' ? 'Timeout' : 'NetworkError');
        });
        return res;
    }

    private static head(res: Response): S3ObjectHead {
        return {
            contentLength: Number(res.headers.get('content-length') ?? '0'),
            contentType: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase(),
            etag: res.headers.get('etag') ?? '',
            meta: Object.fromEntries([...res.headers.entries()].filter(([k]) => k.startsWith('x-amz-meta-')).map(([k, v]) => [k.slice('x-amz-meta-'.length), v])),
        };
    }

    /** Frees the connection of an answer whose status already decided the result: a body that fails to cancel changes nothing. */
    private static async discard(res: Response): Promise<void> {
        await res.body?.cancel().catch(() => undefined);
    }

    private static async fail(op: string, res: Response): Promise<never> {
        // The status is the error: an unreadable body only loses the S3 error code.
        const text = await res.text().catch(() => '');
        throw new S3RequestError(op, res.status, codeOf(text));
    }

    async head(objectKey: string): Promise<S3ObjectHead | null> {
        const res = await this.call('head', 'HEAD', objectKey);
        if (res.status === 404) return null;
        if (!res.ok) return S3ObjectClient.fail('head', res);
        return S3ObjectClient.head(res);
    }

    /** The object, or null; `ifMatch` (an ETag) also reads null when it changed since (412). */
    async get(objectKey: string, opts: { ifMatch?: string; maxBytes?: number } = {}): Promise<S3Object | null> {
        const res = await this.call('get', 'GET', objectKey, opts.ifMatch ? { headers: { 'if-match': opts.ifMatch } } : {});
        if (res.status === 404 || res.status === 412) {
            await S3ObjectClient.discard(res);
            return null;
        }
        if (!res.ok) return S3ObjectClient.fail('get', res);
        const head = S3ObjectClient.head(res);
        if (opts.maxBytes !== undefined && head.contentLength > opts.maxBytes) {
            await S3ObjectClient.discard(res);
            throw new S3RequestError('get', 413, 'TooLarge');
        }
        const body = Buffer.from(await res.arrayBuffer());
        if (opts.maxBytes !== undefined && body.length > opts.maxBytes) throw new S3RequestError('get', 413, 'TooLarge');
        return { ...head, contentLength: body.length, body };
    }

    async put(objectKey: string, body: Buffer, contentType: string, meta: Record<string, string> = {}): Promise<void> {
        const headers = { 'content-type': contentType, ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [`x-amz-meta-${k}`, v])) };
        const res = await this.call('put', 'PUT', objectKey, { headers, body });
        if (!res.ok) return S3ObjectClient.fail('put', res);
        await S3ObjectClient.discard(res);
    }

    /**
     * Server-side copy, with the destination's content type set (metadata
     * REPLACE). With `ifMatch`, only the source version with that ETag is
     * copied: false when it changed or is gone.
     */
    async copy(sourceKey: string, destKey: string, opts: { contentType: string; ifMatch?: string }): Promise<boolean> {
        const headers: Record<string, string> = {
            'x-amz-copy-source': `/${this.cfg.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
            'x-amz-metadata-directive': 'REPLACE',
            'content-type': opts.contentType,
            ...(opts.ifMatch ? { 'x-amz-copy-source-if-match': opts.ifMatch } : {}),
        };
        const res = await this.call('copy', 'PUT', destKey, { headers });
        if (res.status === 404 || res.status === 412) {
            await S3ObjectClient.discard(res);
            return false;
        }
        if (!res.ok) return S3ObjectClient.fail('copy', res);
        // A copy can fail after S3 has sent 200: the error is then in the body.
        const text = await res.text();
        if (/<Error>/.test(text)) {
            const code = codeOf(text);
            if (code === 'PreconditionFailed' || code === 'NoSuchKey') return false;
            throw new S3RequestError('copy', 200, code);
        }
        return true;
    }

    /** Creates the bucket; true when it was created, false when this account already owns it. */
    async createBucket(): Promise<boolean> {
        const body =
            this.cfg.region === 'us-east-1'
                ? undefined
                : Buffer.from(`<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${this.cfg.region}</LocationConstraint></CreateBucketConfiguration>`);
        const res = await this.call('create_bucket', 'PUT', '', body ? { body } : {});
        // An unreadable body cannot prove BucketAlreadyOwnedByYou: a 409 then throws.
        const text = await res.text().catch(() => '');
        if (res.ok) return true;
        if (res.status === 409 && /BucketAlreadyOwnedByYou/.test(text)) return false;
        throw new S3RequestError('create_bucket', res.status, codeOf(text));
    }

    /**
     * The evidence retention as the bucket's lifecycle (§11): the prefix
     * expires after `days`, the staging prefix of cell uploads after one day.
     * Replaces the bucket's lifecycle configuration.
     */
    async putEvidenceLifecycle(days = 30): Promise<void> {
        const rule = (id: string, prefix: string, d: number) =>
            `<Rule><ID>${id}</ID><Filter><Prefix>${prefix}</Prefix></Filter><Status>Enabled</Status><Expiration><Days>${d}</Days></Expiration></Rule>`;
        const xml = Buffer.from(
            `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
                rule('kody-runtime-evidence', this.cfg.prefix, days) +
                rule('kody-runtime-evidence-uploads', `${this.cfg.prefix}${EVIDENCE_S3_STAGING}`, 1) +
                `</LifecycleConfiguration>`,
        );
        const res = await this.call('put_lifecycle', 'PUT', '', {
            query: { lifecycle: '' },
            headers: { 'content-type': 'application/xml', 'content-md5': createHash('md5').update(xml).digest('base64') },
            body: xml,
        });
        if (!res.ok) return S3ObjectClient.fail('put_lifecycle', res);
        await S3ObjectClient.discard(res);
    }

    /**
     * One page (at most 1000) of the keys under `prefix`, with the token of the next page when the listing was
     * truncated (ListObjectsV2). The prefix is an object key prefix, so it carries the bucket's configured prefix.
     */
    async list(prefix: string, continuationToken?: string): Promise<{ keys: string[]; next?: string }> {
        const res = await this.call('list', 'GET', '', {
            query: { 'list-type': '2', prefix, ...(continuationToken ? { 'continuation-token': continuationToken } : {}) },
        });
        if (!res.ok) return S3ObjectClient.fail('list', res);
        const xml = await res.text();
        const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => unescapeXml(m[1]));
        const next = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
        return { keys, ...(next ? { next: unescapeXml(next) } : {}) };
    }

    /**
     * DeleteObjects: up to 1000 keys in one call. A key S3 reports as failed throws with its code (never the key):
     * the caller retries the whole purge, which is idempotent. A key that is already gone is a success.
     */
    async deleteMany(objectKeys: string[]): Promise<void> {
        if (!objectKeys.length) return;
        if (objectKeys.length > 1000) throw new S3RequestError('delete_objects', 400, 'TooManyKeys');
        const xml = Buffer.from(
            `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${objectKeys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('')}</Delete>`,
        );
        const res = await this.call('delete_objects', 'POST', '', {
            query: { delete: '' },
            headers: { 'content-type': 'application/xml', 'content-md5': createHash('md5').update(xml).digest('base64') },
            body: xml,
        });
        if (!res.ok) return S3ObjectClient.fail('delete_objects', res);
        // A 200 can carry per-key errors in the body.
        const text = await res.text();
        if (/<Error>/.test(text)) throw new S3RequestError('delete_objects', 200, codeOf(text));
    }

    async delete(objectKey: string): Promise<void> {
        const res = await this.call('delete', 'DELETE', objectKey);
        if (!res.ok && res.status !== 404) return S3ObjectClient.fail('delete', res);
        await S3ObjectClient.discard(res);
    }
}

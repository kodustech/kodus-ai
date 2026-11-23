import { Agent as HttpsAgent, request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';

import type { HubFleetPort } from './per-run-host';

// runtime-fleet → hub internal fleet routes (hub/http/fleet.controller.ts),
// over mTLS with the fleet's own client certificate (OU=worker, a CN in the
// hub's RUNTIME_FLEET_ALLOWED_CNS). The token comes back once and is sealed
// by the caller's step; it is never logged.

type Post = (url: string, body: string) => Promise<{ status: number; text: string }>;

const MAX_RESPONSE_BYTES = 64 * 1024;

export function fleetPost(opts: { tls?: { cert: string; key: string; ca: string }; testOnlyToken?: string; timeoutMs?: number }): Post {
    const agent = opts.tls ? new HttpsAgent({ cert: opts.tls.cert, key: opts.tls.key, ca: opts.tls.ca, minVersion: 'TLSv1.3', keepAlive: true }) : undefined;
    return (url, body) =>
        new Promise((resolve, reject) => {
            const u = new URL(url);
            if (u.protocol === 'https:' && !agent) return reject(new Error('fleet TLS material is required for an https hub'));
            const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
            if (opts.testOnlyToken) headers.authorization = `Bearer ${opts.testOnlyToken}`;
            const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
            const req = send(u, { method: 'POST', headers, ...(agent ? { agent } : {}) }, (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (c: Buffer) => {
                    size += c.length;
                    if (size > MAX_RESPONSE_BYTES) return req.destroy(new Error('hub answer too large'));
                    chunks.push(c);
                });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
                res.on('error', reject);
            });
            req.setTimeout(opts.timeoutMs ?? 30_000, () => req.destroy(new Error('hub request timed out')));
            req.on('error', reject);
            req.end(body);
        });
}

export class HubFleetClient implements HubFleetPort {
    constructor(
        private readonly hubInternalUrl: string,
        private readonly post: Post,
    ) {}

    async mint(req: { hostId: string; poolId: string; boundKey: string | null; ttlSeconds: number }) {
        const res = await this.post(`${this.hubInternalUrl}/internal/fleet/registration-tokens`, JSON.stringify(req));
        if (res.status === 200) {
            const body = JSON.parse(res.text) as { token?: unknown };
            if (typeof body.token !== 'string' || !body.token.startsWith('kcf_')) throw new Error('hub answered a registration token it should not');
            return { ok: true as const, token: body.token };
        }
        if (res.status === 404 || res.status === 409) {
            const code = (() => {
                try {
                    return String((JSON.parse(res.text) as { code?: unknown }).code ?? 'refused');
                } catch {
                    return 'refused';
                }
            })();
            return { ok: false as const, reason: code };
        }
        throw new Error(`hub fleet token answered ${res.status}`);
    }

    async retire(hostId: string) {
        const res = await this.post(`${this.hubInternalUrl}/internal/fleet/hosts/${encodeURIComponent(hostId)}/retire`, '{}');
        if (res.status !== 200) throw new Error(`hub fleet retire answered ${res.status}`);
    }

    /** Asks the hub to have the template host's cell seal itself; resolves once the cell acked. A refusal throws with the hub's code. */
    async seal(hostId: string) {
        const res = await this.post(`${this.hubInternalUrl}/internal/fleet/hosts/${encodeURIComponent(hostId)}/seal`, '{}');
        if (res.status !== 200) throw new Error(`hub fleet seal answered ${res.status}: ${res.text.slice(0, 200)}`);
    }

    async connection(hostId: string): Promise<{ cellId: string | null; connected: boolean }> {
        const res = await this.post(`${this.hubInternalUrl}/internal/fleet/hosts/${encodeURIComponent(hostId)}/connection`, '{}');
        if (res.status !== 200) throw new Error(`hub fleet connection answered ${res.status}`);
        const b = JSON.parse(res.text) as { cellId?: unknown; connected?: unknown };
        return { cellId: typeof b.cellId === 'string' ? b.cellId : null, connected: b.connected === true };
    }
}

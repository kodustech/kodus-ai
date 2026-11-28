import { readFileSync, statSync } from 'fs';
import { request as httpsRequest } from 'https';

import { RuntimeSecretVaultUnavailableError, type RuntimeSecretVaultPort } from '../domain/secrets';

/**
 * The API's side of OpenBao (docker/openbao): an AppRole whose policy can
 * create, update, patch and delete org secrets under
 * <mount>/data/orgs/<org>/secrets/<id>, and read none. Requests carry no
 * value in a URL, and no backend text crosses back: a failure is a fixed
 * RuntimeSecretVaultUnavailableError.
 */
export interface OpenBaoSecretVaultConfig {
    /** https origin, e.g. https://runtime-openbao:8200. */
    address: string;
    mount: string;
    /** PEM of the CA that signs OpenBao's certificate; undefined: the system roots. */
    ca?: string;
    roleIdFile: string;
    secretIdFile: string;
    timeoutMs: number;
}

/** RUNTIME_OPENBAO_*; undefined when the address is not set (the screen says no store is configured). */
export function loadOpenBaoSecretVaultConfig(env: NodeJS.ProcessEnv = process.env): OpenBaoSecretVaultConfig | undefined {
    const address = env.RUNTIME_OPENBAO_ADDR?.trim();
    if (!address) return undefined;
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.pathname.replace(/\/$/, '') !== '' || url.search || url.username || url.password) {
        throw new Error('RUNTIME_OPENBAO_ADDR must be an https origin');
    }
    const roleIdFile = env.RUNTIME_OPENBAO_ROLE_ID_FILE?.trim();
    const secretIdFile = env.RUNTIME_OPENBAO_SECRET_ID_FILE?.trim();
    if (!roleIdFile || !secretIdFile) throw new Error('RUNTIME_OPENBAO_ROLE_ID_FILE and RUNTIME_OPENBAO_SECRET_ID_FILE are required with RUNTIME_OPENBAO_ADDR');
    const mount = env.RUNTIME_OPENBAO_MOUNT?.trim() || 'runtime-kv';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(mount)) throw new Error('RUNTIME_OPENBAO_MOUNT is not a mount name');
    const caFile = env.RUNTIME_OPENBAO_CA_FILE?.trim();
    return { address: url.origin, mount, ...(caFile ? { ca: readFileSync(caFile, 'utf8') } : {}), roleIdFile, secretIdFile, timeoutMs: 5_000 };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

/** A file the installer wrote for this process only: regular, not readable by group or others. */
function readCredential(path: string): string {
    try {
        const st = statSync(path);
        if (st.isFile() && (st.mode & 0o077) === 0 && st.size <= 4096) return readFileSync(path, 'utf8').trim();
    } catch {
        // The file system's error names the path: a fixed error instead.
    }
    throw new RuntimeSecretVaultUnavailableError('credential file refused');
}

interface BaoResponse {
    status: number;
    body: string;
}

export class OpenBaoSecretVault implements RuntimeSecretVaultPort {
    readonly configured = true;
    private token?: { value: string; renewAt: number };

    constructor(
        private readonly config: OpenBaoSecretVaultConfig,
        private readonly now: () => number = Date.now,
    ) {}

    async write(organizationId: string, secretId: string, secret: { value: string; hosts: string[] }) {
        // The injector refuses a record that is not exactly these four fields, for this org and id.
        const res = await this.authed('POST', this.dataPath(organizationId, secretId), 'application/json', {
            data: { value: secret.value, hosts: secret.hosts, organizationId, secretId },
        });
        if (res.status !== 200 && res.status !== 204) throw new RuntimeSecretVaultUnavailableError(`write answered ${res.status}`);
    }

    async setHosts(organizationId: string, secretId: string, hosts: string[]) {
        const res = await this.authed('PATCH', this.dataPath(organizationId, secretId), 'application/merge-patch+json', { data: { hosts } });
        if (res.status !== 200 && res.status !== 204) throw new RuntimeSecretVaultUnavailableError(`patch answered ${res.status}`);
    }

    async delete(organizationId: string, secretId: string) {
        const res = await this.authed('DELETE', `/v1/${this.config.mount}/metadata/orgs/${this.segment(organizationId)}/secrets/${this.segment(secretId)}`);
        // 404: already gone, which is what a delete wants.
        if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw new RuntimeSecretVaultUnavailableError(`delete answered ${res.status}`);
    }

    private dataPath(organizationId: string, secretId: string) {
        return `/v1/${this.config.mount}/data/orgs/${this.segment(organizationId)}/secrets/${this.segment(secretId)}`;
    }

    private segment(id: string) {
        if (!ID.test(id)) throw new RuntimeSecretVaultUnavailableError('id refused');
        return encodeURIComponent(id);
    }

    private async authed(method: string, path: string, contentType?: string, body?: unknown): Promise<BaoResponse> {
        let res = await this.call(method, path, await this.login(), contentType, body);
        if (res.status === 403 || res.status === 401) {
            // The token was revoked or the role rotated: one fresh login.
            this.token = undefined;
            res = await this.call(method, path, await this.login(), contentType, body);
        }
        return res;
    }

    private async login(): Promise<string> {
        if (this.token && this.now() < this.token.renewAt) return this.token.value;
        const res = await this.call('POST', '/v1/auth/approle/login', undefined, 'application/json', {
            role_id: readCredential(this.config.roleIdFile),
            secret_id: readCredential(this.config.secretIdFile),
        });
        if (res.status !== 200) throw new RuntimeSecretVaultUnavailableError(`login answered ${res.status}`);
        let auth: { client_token?: unknown; lease_duration?: unknown } | undefined;
        try {
            auth = JSON.parse(res.body)?.auth;
        } catch {
            auth = undefined;
        }
        if (typeof auth?.client_token !== 'string' || !auth.client_token) throw new RuntimeSecretVaultUnavailableError('login returned no token');
        const leaseSeconds = typeof auth.lease_duration === 'number' && auth.lease_duration > 0 ? auth.lease_duration : 3600;
        this.token = { value: auth.client_token, renewAt: this.now() + (leaseSeconds * 1000 * 2) / 3 };
        return this.token.value;
    }

    private call(method: string, path: string, token: string | undefined, contentType?: string, body?: unknown): Promise<BaoResponse> {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const url = new URL(path, this.config.address);
        return new Promise((resolve, reject) => {
            const req = httpsRequest(
                url,
                {
                    method,
                    ca: this.config.ca,
                    minVersion: 'TLSv1.2',
                    timeout: this.config.timeoutMs,
                    agent: false,
                    headers: {
                        'X-Vault-Request': 'true',
                        Accept: 'application/json',
                        ...(token ? { 'X-Vault-Token': token } : {}),
                        ...(payload ? { 'Content-Type': contentType ?? 'application/json', 'Content-Length': payload.length } : {}),
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    res.on('data', (c: Buffer) => {
                        size += c.length;
                        if (size <= 256 * 1024) chunks.push(c);
                    });
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
                    res.on('error', () => reject(new RuntimeSecretVaultUnavailableError('response failed')));
                },
            );
            req.on('timeout', () => req.destroy(new Error('timeout')));
            // The transport's own error text may carry request bytes: never pass it on.
            req.on('error', () => reject(new RuntimeSecretVaultUnavailableError('unreachable')));
            if (payload) req.write(payload);
            req.end();
        });
    }
}

/** No store configured: the screen lists nothing it could not have written, and every write is refused. */
export class UnconfiguredSecretVault implements RuntimeSecretVaultPort {
    readonly configured = false;
    async write(): Promise<void> {
        throw new RuntimeSecretVaultUnavailableError('not configured');
    }
    async setHosts(): Promise<void> {
        throw new RuntimeSecretVaultUnavailableError('not configured');
    }
    async delete(): Promise<void> {
        throw new RuntimeSecretVaultUnavailableError('not configured');
    }
}

import { deniedBy, InvalidEgressHostError, normalizeEgressHost } from './egress';

// Org secrets of the Runtime (docs/runtime/sandbox.md "Secrets: OpenBao"): a
// credential a machine uses outward on the org's behalf (a private registry,
// a test API key), bound to the exact hosts it may go to. The value lives in
// OpenBao only: the API writes it and can never read it back, the cell's
// injector reads it and swaps it for the placeholder the machine holds, on
// requests to those hosts only. Kodus keeps the metadata below.

export const RUNTIME_SECRET_VAULT = Symbol.for('RuntimeApi.SecretVault');
export const RUNTIME_SECRET_STORE = Symbol.for('RuntimeApi.SecretStore');

/** The env var the machine sees the placeholder in; upper snake case, starting with a letter. */
export const RUNTIME_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRET_HOSTS = 16;
export const MAX_SECRET_VALUE_BYTES = 8 * 1024;
export const MAX_SECRETS_PER_ORG = 100;

/**
 * Names a machine's own tooling owns: a secret named after them would change
 * what runs, not what it authenticates with. The Go cell drops a secret of
 * these names too (agent.secretNameRefused, from the generated constants).
 */
export const RUNTIME_SECRET_RESERVED_NAMES: ReadonlySet<string> = new Set([
    'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'LANG', 'TERM', 'HOSTNAME',
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'BASH_ENV', 'ENV',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    // The guest agent sets it on every exec, so git never asks for a password (apps/runtime-cell guest).
    'GIT_TERMINAL_PROMPT',
    // The trust variables the cell points at its CA bundle in a claim with secrets (apps/runtime-cell machinetrust.EnvNames).
    'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
]);
export const RUNTIME_SECRET_RESERVED_PREFIXES: readonly string[] = ['KODUS_', 'KODY_', 'RUNTIME_', 'LD_', 'DYLD_'];

export class InvalidRuntimeSecretError extends Error {}

export interface RuntimeSecretActor {
    userId: string;
    email?: string;
}

/** What Kodus keeps about a secret. Never the value. */
export interface RuntimeSecretRecord {
    organizationId: string;
    /** The name, lower case: the secret's id in the store (orgs/<org>/secrets/<id>). */
    secretId: string;
    name: string;
    hosts: string[];
    createdBy: RuntimeSecretActor;
    createdAt: string;
    updatedBy: RuntimeSecretActor;
    updatedAt: string;
    /** When the value was last set or replaced. */
    valueSetAt: string;
}

export type RuntimeSecretAuditAction = 'created' | 'updated' | 'deleted';

/** One change of a secret, as the audit keeps it: who, when, what changed. Never the value. */
export interface RuntimeSecretAuditRecord {
    auditId: string;
    organizationId: string;
    secretId: string;
    name: string;
    action: RuntimeSecretAuditAction;
    /** The hosts after the change (before it, for a delete). */
    hosts: string[];
    valueReplaced: boolean;
    actor: RuntimeSecretActor;
    at: string;
}

/**
 * OpenBao as the API sees it: write-only. There is no read: the API's
 * policy has no read capability on the values (docker/openbao/policies).
 */
export interface RuntimeSecretVaultPort {
    readonly configured: boolean;
    /** Writes a new version: the value and the hosts it may go to. */
    write(organizationId: string, secretId: string, secret: { value: string; hosts: string[] }): Promise<void>;
    /** Changes the hosts of the current version, without the value. */
    setHosts(organizationId: string, secretId: string, hosts: string[]): Promise<void>;
    /** Removes every version: the injector stops finding it at once. */
    delete(organizationId: string, secretId: string): Promise<void>;
}

/**
 * The metadata and its audit, in the product Postgres. Each write runs
 * `effect` (the vault call) inside the same transaction: a vault failure
 * leaves no row and no audit, and a row conflict never reaches the vault.
 */
export interface RuntimeSecretStore {
    list(organizationId: string): Promise<RuntimeSecretRecord[]>;
    count(organizationId: string): Promise<number>;
    /** null when a secret of that name exists. */
    create(record: RuntimeSecretRecord, audit: RuntimeSecretAuditRecord, effect: () => Promise<void>): Promise<RuntimeSecretRecord | null>;
    /** null when the secret does not exist. */
    update(
        organizationId: string,
        secretId: string,
        change: (current: RuntimeSecretRecord) => { next: RuntimeSecretRecord; audit: RuntimeSecretAuditRecord },
        effect: (current: RuntimeSecretRecord, next: RuntimeSecretRecord) => Promise<void>,
    ): Promise<RuntimeSecretRecord | null>;
    /** false when the secret does not exist. */
    delete(
        organizationId: string,
        secretId: string,
        audit: (current: RuntimeSecretRecord) => RuntimeSecretAuditRecord,
        effect: () => Promise<void>,
    ): Promise<boolean>;
    listAudit(organizationId: string, limit: number): Promise<RuntimeSecretAuditRecord[]>;
}

export class RuntimeSecretVaultUnavailableError extends Error {}

export function normalizeSecretName(raw: unknown): string {
    if (typeof raw !== 'string') throw new InvalidRuntimeSecretError('name must be a string');
    const name = raw.trim();
    if (!RUNTIME_SECRET_NAME_PATTERN.test(name)) {
        throw new InvalidRuntimeSecretError('name must be an environment variable name: A-Z, 0-9 and _, starting with a letter, up to 64 characters');
    }
    if (RUNTIME_SECRET_RESERVED_NAMES.has(name) || RUNTIME_SECRET_RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
        throw new InvalidRuntimeSecretError(`${name} is reserved for the machine's own tooling`);
    }
    return name;
}

/** The store id of a secret: its name in lower case (policy.ValidSecretID on the cell). */
export function secretIdOf(name: string): string {
    return name.toLowerCase();
}

/**
 * Exact host names only, as egress approvals take them: no wildcard (so no
 * wildcard over a public suffix), no IP address (the cell's egress refuses
 * IP destinations by name), nothing on the Kodus egress denylist.
 */
export function normalizeSecretHosts(raw: unknown, denylist: readonly string[]): string[] {
    if (!Array.isArray(raw) || raw.length === 0) throw new InvalidRuntimeSecretError('name at least one host the value may go to');
    if (raw.length > MAX_SECRET_HOSTS) throw new InvalidRuntimeSecretError(`at most ${MAX_SECRET_HOSTS} hosts`);
    const hosts = new Set<string>();
    for (const h of raw) {
        let host: string;
        try {
            host = normalizeEgressHost(h);
        } catch (e) {
            if (e instanceof InvalidEgressHostError) throw new InvalidRuntimeSecretError(`${typeof h === 'string' ? h.slice(0, 260) : 'host'}: ${e.message}`);
            throw e;
        }
        const rule = deniedBy(host, denylist);
        if (rule) throw new InvalidRuntimeSecretError(`${host} is on the Kodus egress denylist (${rule}): a secret cannot go there`);
        hosts.add(host);
    }
    return [...hosts].sort();
}

/** A value that can stand in an HTTP header: printable, one line, at most 8 KiB. The message never repeats it. */
export function validateSecretValue(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0) throw new InvalidRuntimeSecretError('value must be a non-empty string');
    if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_VALUE_BYTES) throw new InvalidRuntimeSecretError('value is longer than 8 KiB');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(raw)) throw new InvalidRuntimeSecretError('value must be one line of printable characters');
    return raw;
}

/** The view of a secret on the screen and in the API: metadata only. */
export function secretView(r: RuntimeSecretRecord) {
    return {
        secretId: r.secretId,
        name: r.name,
        hosts: r.hosts,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedBy: r.updatedBy,
        updatedAt: r.updatedAt,
        valueSetAt: r.valueSetAt,
    };
}

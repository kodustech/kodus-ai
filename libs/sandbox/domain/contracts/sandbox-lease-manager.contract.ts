import { CreateSandboxParams, SandboxInstance } from './sandbox.provider';

export const SANDBOX_LEASE_MANAGER_TOKEN = Symbol('SandboxLeaseManager');

/**
 * Thrown by acquire() when the lease was invalidated — the PR was closed or
 * force-pushed — while the sandbox was being acquired or created. This is a
 * SUPERSEDE, not a failure: the review is moot (a force-push re-triggers a
 * fresh review on the new head; a closed PR needs none). Callers should treat
 * it as such and continue self-contained, NOT log it as an error.
 */
export class SandboxInvalidatedError extends Error {
    constructor(prKey: string, midCreate = false, options?: ErrorOptions) {
        super(
            `SandboxLeaseManager: sandbox invalidated${
                midCreate ? ' mid-create' : ''
            } for prKey="${prKey}"`,
            options,
        );
        this.name = 'SandboxInvalidatedError';
    }
}

export interface AcquireResult {
    sandbox: SandboxInstance;
    leaseId: string;
    sandboxId: string;
    /**
     * True when this acquire cold-created a new sandbox (creator path).
     * False when it connected to an existing paused/running sandbox (joiner path).
     * Used by Phase 4 instrumentation to label sandboxState as 'cold-create' vs 'paused-resumed'.
     */
    wasCreated: boolean;
}

export interface ISandboxLeaseManager {
    /**
     * Acquire a lease on the sandbox for the given prKey. If no sandbox exists
     * yet, the manager cold-creates one using `cloneParams` (or falls back to
     * NullSandbox when `cloneParams` is omitted and no sandbox provider is
     * configured). Subsequent acquires on the same prKey return the existing
     * sandbox via warm-resume.
     */
    acquire(
        prKey: string,
        consumer: string,
        leaseTtlMs?: number,
        cloneParams?: CreateSandboxParams,
    ): Promise<AcquireResult>;
    release(leaseId: string, opts?: { idleMs?: number }): Promise<void>;
    invalidate(prKey: string): Promise<void>;
}

/**
 * Canonical prKey builder — produces "{organizationId}:{repositoryId}:{prNumber}".
 *
 * SECURITY: validates each segment to prevent malformed keys that could
 * collide across tenants or sneak through downstream parsers. organizationId
 * MUST be a UUID (matching how the platform issues org ids); repositoryId
 * and prNumber must be non-empty and free of the ":" separator. A bad input
 * throws — no fallback, no silent acceptance.
 */
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildPrKey(
    organizationId: string,
    repositoryId: string,
    prNumber: number | string,
): string {
    if (!organizationId || !UUID_RE.test(organizationId)) {
        throw new Error(
            `buildPrKey: organizationId must be a UUID, got ${JSON.stringify(organizationId)}`,
        );
    }
    const repoStr = String(repositoryId);
    const prStr = String(prNumber);
    if (!repoStr || repoStr.includes(':')) {
        throw new Error(
            `buildPrKey: repositoryId must be non-empty and contain no ":" — got ${JSON.stringify(repositoryId)}`,
        );
    }
    if (!prStr || prStr.includes(':')) {
        throw new Error(
            `buildPrKey: prNumber must be non-empty and contain no ":" — got ${JSON.stringify(prNumber)}`,
        );
    }
    return `${organizationId}:${repoStr}:${prStr}`;
}

/**
 * Validate a prKey passed by an internal caller (webhook handler, pipeline
 * stage). Used by SandboxLeaseManager.acquire() as a defense-in-depth check
 * so a bad caller can't poison the lease collection.
 */
export function assertValidPrKey(prKey: string): void {
    const parts = prKey.split(':');
    // PR mode: <orgId>:<repoId>:<prNumber>
    // CLI mode: <orgId>:<repoId>:cli:<branch>
    if (parts.length !== 3 && parts.length !== 4) {
        throw new Error(
            `Invalid prKey shape: ${JSON.stringify(prKey)} (expected 3 or 4 ":"-separated segments)`,
        );
    }
    // Accept the literal `'trial'` for public-demo / anonymous flows.
    // Real tenants always use a UUID; the demo pipeline runs without
    // a registered organization and needs a sandbox lease too. The
    // string is namespaced enough that it can't collide with a real
    // org id (UUIDs are 36 chars with dashes).
    if (parts[0] !== 'trial' && !UUID_RE.test(parts[0])) {
        throw new Error(
            `Invalid prKey: first segment must be a UUID organizationId or 'trial', got ${JSON.stringify(parts[0])}`,
        );
    }
    if (!parts[1]) {
        throw new Error(
            `Invalid prKey: missing repositoryId in ${JSON.stringify(prKey)}`,
        );
    }
    if (!parts[2]) {
        throw new Error(
            `Invalid prKey: missing prNumber/marker in ${JSON.stringify(prKey)}`,
        );
    }
}

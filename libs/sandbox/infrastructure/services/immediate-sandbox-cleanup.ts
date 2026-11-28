import {
    deleteLocalSandbox,
    isLocalSandboxPath,
} from './local-sandbox-cleanup.service';

/**
 * A runtime sandbox (runtime-sandbox provider): `runtime:<orgId>:<uuid>`,
 * a claim on a Kody Runtime cell. Like a local sandbox it is never reused
 * across leases and is ended as soon as its last lease goes.
 */
const RUNTIME_SANDBOX_ID =
    /^runtime:([A-Za-z0-9_.:-]{1,128}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function runtimeSandboxId(organizationId: string, uuid: string): string {
    return `runtime:${organizationId}:${uuid}`;
}

export function parseRuntimeSandboxId(
    sandboxId: string | null | undefined,
): { organizationId: string; uuid: string } | null {
    const m =
        typeof sandboxId === 'string'
            ? RUNTIME_SANDBOX_ID.exec(sandboxId)
            : null;
    return m ? { organizationId: m[1], uuid: m[2] } : null;
}

type RuntimeSandboxReleaser = (ref: {
    organizationId: string;
    sandboxId: string;
}) => Promise<void>;
let runtimeReleaser: RuntimeSandboxReleaser | undefined;

/** Set by the runtime-sandbox provider: how a lease's runtime sandbox is ended. */
export function setRuntimeSandboxReleaser(
    r: RuntimeSandboxReleaser | undefined,
): void {
    runtimeReleaser = r;
}

/** A sandbox the lease manager and the reaper end at once (a local directory or a runtime claim), never idle-killed through E2B. */
export function isImmediateCleanupSandbox(
    sandboxId: string | null | undefined,
): boolean {
    return (
        isLocalSandboxPath(sandboxId) ||
        parseRuntimeSandboxId(sandboxId) !== null
    );
}

/** Ends an immediate-cleanup sandbox; a runtime one is released on its cell. */
export async function deleteImmediateSandbox(sandboxId: string): Promise<void> {
    const runtime = parseRuntimeSandboxId(sandboxId);
    if (!runtime) return deleteLocalSandbox(sandboxId);
    if (!runtimeReleaser) {
        throw new Error(
            'no runtime sandbox provider is configured to release this sandbox',
        );
    }
    await runtimeReleaser({
        organizationId: runtime.organizationId,
        sandboxId: runtime.uuid,
    });
}

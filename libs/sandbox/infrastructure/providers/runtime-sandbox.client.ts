import {
    ENV_SESSION_SIGNATURE_HEADER,
    envSessionKeyFrom,
    signEnvSessionRequest,
} from '@libs/runtime/contracts/env-session';
import {
    SANDBOX_ROUTES,
    type SandboxOpen,
    type SandboxRef,
    type SandboxView,
} from '@libs/runtime/contracts/sandbox';
import type { SandboxOp, SandboxResult } from '@libs/runtime/protocol/sandbox';
import { sealingKeyFrom } from '@libs/runtime/run/sealed-secret';

// The runtime-sandbox provider's door to the Kody Runtime: the
// runtime-worker's listener (RUNTIME_SANDBOX_URL, or the env-session one),
// every request signed with the key derived from RUNTIME_SECRET_SEAL_KEY,
// which the product and the runtime-worker already share.

type Fetch = (
    url: string,
    init: {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal: AbortSignal;
    },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface RuntimeSandboxClientConfig {
    baseUrl?: string;
    secretSealKey?: string;
}

/** The runtime's answer when it refused (status, its code and message). */
export class RuntimeSandboxError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

export class RuntimeSandboxClient {
    private readonly key?: Buffer;

    constructor(
        private readonly config: RuntimeSandboxClientConfig,
        private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
        private readonly now: () => number = () => Date.now(),
    ) {
        this.key = config.secretSealKey
            ? envSessionKeyFrom(sealingKeyFrom(config.secretSealKey))
            : undefined;
    }

    get configured(): boolean {
        return !!this.config.baseUrl && !!this.key;
    }

    private async post<T>(
        path: string,
        body: unknown,
        timeoutMs: number,
    ): Promise<T> {
        if (!this.config.baseUrl || !this.key)
            throw new RuntimeSandboxError(
                503,
                'sandbox_off',
                'the Kody Runtime sandbox is not configured',
            );
        const raw = JSON.stringify(body);
        let res: { status: number; text(): Promise<string> };
        try {
            res = await this.fetchImpl(
                `${this.config.baseUrl.replace(/\/+$/, '')}${path}`,
                {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        [ENV_SESSION_SIGNATURE_HEADER]: signEnvSessionRequest(
                            this.key,
                            { method: 'POST', path, body: raw, at: this.now() },
                        ),
                    },
                    body: raw,
                    signal: AbortSignal.timeout(timeoutMs),
                },
            );
        } catch (e) {
            throw new RuntimeSandboxError(
                503,
                'runtime_unreachable',
                `the Kody Runtime did not answer: ${(e as Error).message}`,
            );
        }
        let parsed: any;
        try {
            parsed = JSON.parse(await res.text());
        } catch {
            parsed = {};
        }
        if (res.status === 200 && parsed && typeof parsed === 'object')
            return parsed as T;
        throw new RuntimeSandboxError(
            res.status,
            String(parsed?.code ?? 'refused'),
            String(
                parsed?.message ?? `the Kody Runtime answered ${res.status}`,
            ).slice(0, 500),
        );
    }

    open(req: SandboxOpen): Promise<SandboxView> {
        return this.post(SANDBOX_ROUTES.open, req, 5 * 60_000);
    }

    op(ref: SandboxRef, stepId: string, op: SandboxOp): Promise<SandboxResult> {
        return this.post(
            SANDBOX_ROUTES.op,
            { ...ref, stepId, op },
            (op.timeoutMs ?? 60_000) + 90_000,
        );
    }

    renew(ref: SandboxRef): Promise<unknown> {
        return this.post(SANDBOX_ROUTES.renew, ref, 30_000);
    }

    /**
     * Closes the sandbox's egress for good: from the answer on its network
     * allows nothing, and it never opens again. Resolves only with a seal
     * the cell confirmed; anything else is an error the caller must treat as
     * an open sandbox.
     */
    async seal(ref: SandboxRef): Promise<{ sealed: true }> {
        const r = await this.post<{ sealed?: unknown }>(
            SANDBOX_ROUTES.seal,
            ref,
            60_000,
        );
        if (r.sealed !== true)
            throw new RuntimeSandboxError(
                502,
                'seal_unconfirmed',
                'the Kody Runtime did not confirm the egress seal',
            );
        return { sealed: true };
    }

    async release(ref: SandboxRef): Promise<void> {
        await this.post(SANDBOX_ROUTES.release, ref, 30_000);
    }
}

import {
    ENV_SESSION_OPEN_WAIT_MS,
    ENV_SESSION_SIGNATURE_HEADER,
    type EnvSessionOpen,
    type EnvSessionOwner,
    type EnvSessionView,
    type EnvValidationResolution,
    type EnvStepView,
    envSessionKeyFrom,
    signEnvSessionRequest,
} from '@libs/runtime/contracts/env-session';
import { PREVIEW_ROUTES, type PreviewOpen, type PreviewRef, type PreviewView } from '@libs/runtime/contracts/preview';
import { sealingKeyFrom } from '@libs/runtime/run/sealed-secret';

import { EnvSessionPortError, type RuntimeEnvSessionPort } from '../domain/env-tools';
import type { RuntimePreviewPort } from '../domain/previews';

// The API → runtime-worker env-session listener (RUNTIME_ENV_SESSION_URL).
// Each request is signed with a key derived from RUNTIME_SECRET_SEAL_KEY, which
// the API and the worker already share; nothing else authenticates it. The
// listener belongs on the private network only. The preview routes
// (PREVIEW_ROUTES, docs/runtime/preview-urls.md §9.2) live on the same
// listener and are signed the same way.

type Fetch = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

const TIMEOUT_MS = 30_000;

export interface EnvSessionClientConfig {
    baseUrl?: string;
    secretSealKey?: string;
}

export function loadEnvSessionClientConfig(env: NodeJS.ProcessEnv = process.env): EnvSessionClientConfig {
    return { baseUrl: env.RUNTIME_ENV_SESSION_URL || undefined, secretSealKey: env.RUNTIME_SECRET_SEAL_KEY || undefined };
}

export class HttpEnvSessionClient implements RuntimeEnvSessionPort, RuntimePreviewPort {
    private readonly key?: Buffer;

    constructor(
        private readonly config: EnvSessionClientConfig,
        private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
        private readonly now: () => number = () => Date.now(),
    ) {
        this.key = config.secretSealKey ? envSessionKeyFrom(sealingKeyFrom(config.secretSealKey)) : undefined;
    }

    private async post<T>(
        path: string,
        body: unknown,
        timeoutMs = TIMEOUT_MS,
        off: { code: string; message: string } = { code: 'env_sessions_off', message: 'Interactive environments are not configured on this deployment.' },
    ): Promise<T> {
        if (!this.config.baseUrl || !this.key) {
            throw new EnvSessionPortError(503, off.code, off.message);
        }
        const raw = JSON.stringify(body);
        let res: { status: number; text(): Promise<string> };
        try {
            res = await this.fetchImpl(`${this.config.baseUrl.replace(/\/+$/, '')}${path}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    [ENV_SESSION_SIGNATURE_HEADER]: signEnvSessionRequest(this.key, { method: 'POST', path, body: raw, at: this.now() }),
                },
                body: raw,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch {
            throw new EnvSessionPortError(503, 'runtime_unreachable', 'The Kody Runtime did not answer. Try again in a minute.');
        }
        let parsed: any;
        try {
            parsed = JSON.parse(await res.text());
        } catch {
            parsed = {};
        }
        if (res.status === 200 && parsed && typeof parsed === 'object') return parsed as T;
        if (res.status === 404) throw new EnvSessionPortError(404, 'not_found', 'not found');
        if (res.status === 409 || res.status === 429)
            throw new EnvSessionPortError(res.status, String(parsed?.code ?? 'refused'), String(parsed?.message ?? 'refused').slice(0, 500));
        // 400/401/5xx are ours to fix, not the dev's: a generic 503 without the worker's detail.
        throw new EnvSessionPortError(503, 'runtime_error', 'The Kody Runtime could not take this request.');
    }

    open(req: EnvSessionOpen) {
        return this.post<EnvSessionView>('/env/sessions', req, ENV_SESSION_OPEN_WAIT_MS + TIMEOUT_MS);
    }

    status(owner: EnvSessionOwner, sessionId: string) {
        return this.post<EnvSessionView>(`/env/sessions/${encodeURIComponent(sessionId)}/status`, owner);
    }

    validation(owner: EnvSessionOwner,sessionId:string,name:string) {
        return this.post<EnvValidationResolution>(`/env/sessions/${encodeURIComponent(sessionId)}/validation`,{...owner,name});
    }

    exec(owner: EnvSessionOwner, sessionId: string, req: { stepId: string; command: string; cwd?: string; timeoutMs: number; validationName?:string; executionScope?:'workload' }) {
        return this.post<EnvStepView>(`/env/sessions/${encodeURIComponent(sessionId)}/exec`, { ...owner, ...req });
    }

    step(owner: EnvSessionOwner, stepId: string) {
        return this.post<EnvStepView>(`/env/steps/${encodeURIComponent(stepId)}`, owner);
    }

    release(owner: EnvSessionOwner, sessionId: string) {
        return this.post<EnvSessionView>(`/env/sessions/${encodeURIComponent(sessionId)}/release`, owner);
    }

    openPreview(req: PreviewOpen) {
        return this.post<PreviewView>(PREVIEW_ROUTES.open, req, TIMEOUT_MS, PREVIEW_UNREACHABLE);
    }

    previewStatus(ref: PreviewRef) {
        return this.post<PreviewView>(PREVIEW_ROUTES.status, ref, TIMEOUT_MS, PREVIEW_UNREACHABLE);
    }

    stopPreview(ref: PreviewRef) {
        return this.post<PreviewView>(PREVIEW_ROUTES.stop, ref, TIMEOUT_MS, PREVIEW_UNREACHABLE);
    }
}

/** No worker listener configured: previews cannot open on this deployment (the same code as no preview domain). */
const PREVIEW_UNREACHABLE = { code: 'preview_off', message: 'Previews are off on this deployment: the Kody Runtime worker is not configured (RUNTIME_ENV_SESSION_URL).' };

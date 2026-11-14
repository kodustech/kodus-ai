import type { LlmGateway, LlmRequest, LlmResponse } from '../agent/llm-gateway';

// Canaries (ADR-043): per-Run decoy credentials planted in the machine (an
// .npmrc token, a config file key, a seed row). Nothing legitimate ever reads
// them out of the VM, so a canary showing up in a prompt, an outbound
// request, the evidence or the comment means something crossed a boundary:
// the Run stops as a security blocker. The values never leave the control
// plane: they are not logged, not checkpointed, not projected, not published.

export { HmacCanaryVault, containsCanary } from '@libs/runtime/canary';
export type { Canary, CanarySlot, CanaryVault, LeakSite } from '@libs/runtime/canary';
import { HmacCanaryVault, containsCanary, type Canary, type CanaryVault, type LeakSite } from '@libs/runtime/canary';

/** A canary crossed a boundary. The message names where, never the value. */
export class CanaryLeakError extends Error {
    readonly code = 'canary_leak';
    constructor(readonly where: LeakSite) {
        super(`security event: a canary crossed a boundary (${where})`);
        this.name = 'CanaryLeakError';
    }
}

const SITES: LeakSite[] = ['llm_prompt', 'probe_output', 'exec_output', 'egress', 'publish'];

/** By name and message, so it still matches after DBOS serialized the error of a recorded step. */
export function canaryLeakSite(e: unknown): LeakSite | undefined {
    const err = e as { name?: string; code?: string; where?: string; message?: string } | undefined;
    if (!err || (err.name !== 'CanaryLeakError' && err.code !== 'canary_leak')) return undefined;
    if (err.where && SITES.includes(err.where as LeakSite)) return err.where as LeakSite;
    const m = /\((\w+)\)$/.exec(err.message ?? '');
    return m && SITES.includes(m[1] as LeakSite) ? (m[1] as LeakSite) : 'llm_prompt';
}

export const isCanaryLeak = (e: unknown) => canaryLeakSite(e) !== undefined;

const forms = (c: Canary) => {
    const b64 = (s: string) => Buffer.from(s).toString('base64').replace(/=+$/, '');
    const b64url = (s: string) => Buffer.from(s).toString('base64url');
    return [c.value, b64(c.value), b64url(c.value), b64(c.core), b64url(c.core)];
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces every canary form with [redacted]. */
export function redactCanaries(text: string, canaries: Canary[]): string {
    let out = text;
    for (const c of canaries) {
        for (const f of forms(c)) out = out.split(f).join('[redacted]');
        out = out.replace(new RegExp(escapeRe(c.core), 'gi'), '[redacted]');
    }
    return out;
}

/** Redacts any JSON-shaped value (verdicts, egress hosts, summaries). */
export function redactDeep<T>(value: T, canaries: Canary[]): T {
    if (value === undefined || canaries.length === 0) return value;
    return JSON.parse(redactCanaries(JSON.stringify(value), canaries));
}

/**
 * The LLM gateway of the control plane checks every prompt for the Run's
 * canaries before sending it (ADR-043) and refuses to send a prompt that
 * carries one.
 */
export class CanaryGuardedLlmGateway implements LlmGateway {
    constructor(
        private readonly inner: LlmGateway,
        private readonly vault: CanaryVault,
    ) {}

    async complete(req: LlmRequest): Promise<LlmResponse> {
        const canaries = this.vault.forRun(req);
        if (req.messages.some((m) => containsCanary(m.content, canaries))) throw new CanaryLeakError('llm_prompt');
        return this.inner.complete(req);
    }
}

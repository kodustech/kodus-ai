import { createHmac } from 'crypto';

export type CanarySlot = 'npmrc' | 'config' | 'seed';

export interface Canary {
    slot: CanarySlot;
    /** The planted text. */
    value: string;
    /** The random part; matched case-insensitively, so a lowercased or prefix-stripped copy is still caught. */
    core: string;
}

export type LeakSite =
    'llm_prompt' | 'probe_output' | 'exec_output' | 'egress' | 'publish';

/** The canaries of one Run. Deterministic for the same Run, so a resumed workflow sees the same ones. */
export interface CanaryVault {
    forRun(run: { runId: string; runToken: string }): Canary[];
}

const SLOTS: CanarySlot[] = ['npmrc', 'config', 'seed'];
const DOMAIN = 'kody-runtime/canary/v1';

/**
 * Derives each canary as HMAC(key, runId, runToken, slot). The run token is a
 * per-Run secret that never enters the VM (ADR-057), so the VM cannot compute
 * the canaries, and no value has to be stored to survive a worker restart.
 */
export class HmacCanaryVault implements CanaryVault {
    constructor(private readonly key: string | Buffer = DOMAIN) {}

    forRun(run: { runId: string; runToken: string }): Canary[] {
        return SLOTS.map((slot) => {
            const core = createHmac('sha256', this.key)
                .update(`${run.runId}\0${run.runToken}\0${slot}`)
                .digest('hex')
                .slice(0, 32);
            const value =
                slot === 'npmrc'
                    ? `npm_${core}`
                    : slot === 'config'
                      ? `kdx_live_${core}`
                      : `seed_${core}`;
            return { slot, value, core };
        });
    }
}

const forms = (c: Canary) => {
    const b64 = (s: string) =>
        Buffer.from(s).toString('base64').replace(/=+$/, '');
    const b64url = (s: string) => Buffer.from(s).toString('base64url');
    return [
        c.value,
        b64(c.value),
        b64url(c.value),
        b64(c.core),
        b64url(c.core),
    ];
};

/** Whether any canary appears in the text: verbatim, base64, or its random part in any case. */
export function containsCanary(text: string, canaries: Canary[]): boolean {
    if (!text || canaries.length === 0) return false;
    const lower = text.toLowerCase();
    return canaries.some(
        (c) => lower.includes(c.core) || forms(c).some((f) => text.includes(f)),
    );
}

export const canaryKeyFrom = (sealKey: Buffer) =>
    createHmac('sha256', sealKey).update('kody-runtime/canary/v1').digest();

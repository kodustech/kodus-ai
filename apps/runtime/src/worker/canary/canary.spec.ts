import type { LlmGateway } from '../agent/llm-gateway';
import {
    CanaryGuardedLlmGateway,
    CanaryLeakError,
    canaryLeakSite,
    containsCanary,
    HmacCanaryVault,
    redactCanaries,
    redactDeep,
} from './canary';

const RUN = { runId: '7d0f3c1e-5b8a-4c2e-9f1d-2a3b4c5d6e7f', runToken: 'fake-run-token' };

describe('canaries', () => {
    const vault = new HmacCanaryVault();
    const canaries = vault.forRun(RUN);

    it('one per slot, stable for the same Run, different for another Run', () => {
        expect(canaries.map((c) => c.slot)).toEqual(['npmrc', 'config', 'seed']);
        expect(vault.forRun(RUN)).toEqual(canaries);
        expect(vault.forRun({ ...RUN, runId: 'other' })[0].value).not.toBe(canaries[0].value);
        expect(vault.forRun({ ...RUN, runToken: 'other' })[0].value).not.toBe(canaries[0].value);
        expect(new Set(canaries.map((c) => c.core)).size).toBe(3);
    });

    it('is found verbatim, base64-encoded, or by its random part in any case', () => {
        const [npm] = canaries;
        expect(containsCanary(`_authToken=${npm.value}`, canaries)).toBe(true);
        expect(containsCanary(Buffer.from(npm.value).toString('base64'), canaries)).toBe(true);
        expect(containsCanary(`${npm.core.toUpperCase()}.exfil.example.test`, canaries)).toBe(true);
        expect(containsCanary('{"items":[]}', canaries)).toBe(false);
    });

    it('redaction removes every form', () => {
        const [npm, cfg] = canaries;
        const text = `a ${npm.value} b ${cfg.core.toUpperCase()} c ${Buffer.from(npm.value).toString('base64')}`;
        const out = redactCanaries(text, canaries);
        expect(containsCanary(out, canaries)).toBe(false);
        expect(out).toContain('[redacted]');
        expect(redactDeep({ host: `${cfg.core}.x.test` }, canaries)).toEqual({ host: '[redacted].x.test' });
    });

    it('the guarded gateway refuses to send a prompt that carries a canary', async () => {
        const calls: unknown[] = [];
        const inner: LlmGateway = { complete: async (r) => (calls.push(r), { text: '{}', usage: { inputTokens: 1, outputTokens: 1 } }) };
        const llm = new CanaryGuardedLlmGateway(inner, vault);
        const req = { ...RUN, organizationId: 'o', task: 'runtime.plan' as const };
        await llm.complete({ ...req, messages: [{ role: 'user', content: 'hello' }] });
        const err = await llm.complete({ ...req, messages: [{ role: 'user', content: `cat ~/.npmrc: ${canaries[0].value}` }] }).catch((e) => e);
        expect(err).toBeInstanceOf(CanaryLeakError);
        expect(err.message).not.toContain(canaries[0].core);
        expect(calls).toHaveLength(1);
    });

    it('a leak is recognized after DBOS serialized the error of a recorded step', () => {
        const e = new CanaryLeakError('probe_output');
        expect(canaryLeakSite(e)).toBe('probe_output');
        expect(canaryLeakSite({ name: e.name, message: e.message })).toBe('probe_output');
        expect(canaryLeakSite(new Error('boom'))).toBeUndefined();
    });
});

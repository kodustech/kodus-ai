/**
 * Unit tests for resolveAgentModel — the ONE way every harness agent resolves
 * its model. It's a thin seam over the shared build primitive: it must build
 * from the SAME buildModelFromSlot the rest of the funnel uses, then wrap the
 * result in the BYOK concurrency limiter + failure reporter. These lock that
 * wiring (build delegation + wrap config) so the agent path can't drift into a
 * parallel resolver.
 */
import { resolveAgentModel } from './agent-model';
import { buildModelFromSlot } from './byok-to-vercel';
import { wrapByokModel } from './byok-model-wrapper';
import type { NormalizedModel } from './byok-config';

jest.mock('./byok-to-vercel', () => ({
    buildModelFromSlot: jest.fn(() => ({ __built: true })),
}));
jest.mock('./byok-model-wrapper', () => ({
    wrapByokModel: jest.fn((model, cfg) => ({ __wrapped: model, cfg })),
}));

const slot = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    apiKey: 'ciphertext',
} as unknown as NormalizedModel;

beforeEach(() => {
    (buildModelFromSlot as jest.Mock).mockClear();
    (wrapByokModel as jest.Mock).mockClear();
});

describe('resolveAgentModel', () => {
    it('builds from the shared buildModelFromSlot and wraps the result', () => {
        const out = resolveAgentModel(slot);

        expect(buildModelFromSlot).toHaveBeenCalledTimes(1);
        expect(buildModelFromSlot).toHaveBeenCalledWith(
            slot,
            undefined,
            undefined,
        );
        // The wrapped model IS what buildModelFromSlot returned.
        expect((wrapByokModel as jest.Mock).mock.calls[0][0]).toEqual({
            __built: true,
        });
        expect(out).toMatchObject({ __wrapped: { __built: true } });
    });

    it('forwards modelOptions (e.g. structuredOutputs) to the build', () => {
        resolveAgentModel(slot, { modelOptions: { structuredOutputs: true } });
        expect(buildModelFromSlot).toHaveBeenCalledWith(
            slot,
            { structuredOutputs: true },
            undefined,
        );
    });

    it('threads defaultModelOverride to the build (trial / cli-review default)', () => {
        resolveAgentModel(undefined, {
            defaultModelOverride: 'kimi-k2.7-code',
        });
        expect(buildModelFromSlot).toHaveBeenCalledWith(
            undefined,
            undefined,
            'kimi-k2.7-code',
        );
    });

    it('stamps the organization scope onto the built and wrapped slot', () => {
        resolveAgentModel(slot, { organizationId: 'org-1' });
        const scopedSlot = { ...slot, organizationId: 'org-1' };
        expect(buildModelFromSlot).toHaveBeenCalledWith(
            scopedSlot,
            undefined,
            undefined,
        );
        const cfg = (wrapByokModel as jest.Mock).mock.calls[0][1];
        expect(cfg).toMatchObject({
            byokConfig: scopedSlot,
            organizationId: 'org-1',
            provider: 'anthropic',
        });
    });

    it('an explicit provider override wins over the slot provider', () => {
        resolveAgentModel(slot, { provider: 'anthropic_compatible' });
        expect((wrapByokModel as jest.Mock).mock.calls[0][1].provider).toBe(
            'anthropic_compatible',
        );
    });

    it('omits queueTimeoutMs and reporter when not provided', () => {
        resolveAgentModel(slot);
        const cfg = (wrapByokModel as jest.Mock).mock.calls[0][1];
        expect(cfg).not.toHaveProperty('queueTimeoutMs');
        expect(cfg).not.toHaveProperty('reporter');
    });

    it('threads queueTimeoutMs and reporter through when provided', () => {
        const reporter = jest.fn();
        resolveAgentModel(slot, { queueTimeoutMs: 5000, reporter });
        const cfg = (wrapByokModel as jest.Mock).mock.calls[0][1];
        expect(cfg.queueTimeoutMs).toBe(5000);
        expect(cfg.reporter).toBe(reporter);
    });

    it('handles an undefined slot (managed / no-BYOK) — build resolves the default, provider is undefined', () => {
        resolveAgentModel(undefined, { organizationId: 'org-2' });
        expect(buildModelFromSlot).toHaveBeenCalledWith(
            undefined,
            undefined,
            undefined,
        );
        const cfg = (wrapByokModel as jest.Mock).mock.calls[0][1];
        expect(cfg.byokConfig).toBeUndefined();
        expect(cfg.provider).toBeUndefined();
    });
});

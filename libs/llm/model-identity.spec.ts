import { agentModelIdentity } from './model-identity';
import type { NormalizedModel } from './byok-config';

// getModelName is the canonical model-name derivation (managed-slot); mock it so
// this spec locks agentModelIdentity's WIRING (slot → identity quartet), not the
// name cascade itself (covered by managed-slot/byok-to-vercel specs).
jest.mock('./managed-slot', () => ({
    getModelName: (slot?: { provider?: string; model?: string }) =>
        slot ? `${slot.provider}:${slot.model}` : 'env:default-model',
}));

const slot = (over: Partial<NormalizedModel> = {}): NormalizedModel =>
    ({
        provider: 'openai',
        model: 'gpt-x',
        apiKey: 'ciphertext',
        byokModelId: 'bm-1',
        credentialId: 'cred-1',
        ...over,
    }) as NormalizedModel;

describe('agentModelIdentity — the ONE slot → identity derivation', () => {
    it('a BYOK slot → isByok true, name from getModelName, attribution ids carried', () => {
        expect(agentModelIdentity(slot())).toEqual({
            model: 'openai:gpt-x',
            isByok: true,
            byokModelId: 'bm-1',
            credentialId: 'cred-1',
        });
    });

    it('no slot (env/managed default) → isByok false, real default name, ids undefined', () => {
        // The env/managed run is NOT model-less: the name comes from getModelName,
        // never a placeholder, so the span still carries gen_ai.response.model.
        expect(agentModelIdentity(undefined)).toEqual({
            model: 'env:default-model',
            isByok: false,
            byokModelId: undefined,
            credentialId: undefined,
        });
    });

    it('a slot without attribution ids still resolves (ids undefined, not thrown)', () => {
        expect(
            agentModelIdentity(
                slot({ byokModelId: undefined, credentialId: undefined }),
            ),
        ).toEqual({
            model: 'openai:gpt-x',
            isByok: true,
            byokModelId: undefined,
            credentialId: undefined,
        });
    });
});

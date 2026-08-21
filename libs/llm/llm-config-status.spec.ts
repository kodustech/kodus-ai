import {
    isByokSlotConfigured,
    isV2ModelResolvable,
} from './llm-config-status';
import { BYOKProvider } from './model-providers';
import type { BYOKCredential } from './byok-config';

// Locks the two pure predicates at their kernel home (moved out of the org
// use-case). describeLLMConfigStatus is exercised end-to-end by
// get-llm-config-status.use-case.spec.ts.
describe('isByokSlotConfigured — provider-aware auth-material check', () => {
    it('most providers: configured iff an apiKey is present', () => {
        expect(isByokSlotConfigured({ provider: BYOKProvider.OPENAI, apiKey: 'k' })).toBe(true);
        expect(isByokSlotConfigured({ provider: BYOKProvider.OPENAI })).toBe(false);
    });

    it('Amazon Bedrock: bearer token OR static IAM pair, never apiKey', () => {
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.AMAZON_BEDROCK,
                awsBearerToken: 't',
            }),
        ).toBe(true);
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.AMAZON_BEDROCK,
                awsAccessKeyId: 'a',
                awsSecretAccessKey: 's',
            }),
        ).toBe(true);
        // apiKey alone is NOT enough for Bedrock
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.AMAZON_BEDROCK,
                apiKey: 'k',
            }),
        ).toBe(false);
    });

    it('null / undefined → false', () => {
        expect(isByokSlotConfigured(null)).toBe(false);
        expect(isByokSlotConfigured(undefined)).toBe(false);
    });
});

describe('isV2ModelResolvable — per-model resolvability', () => {
    const cred = (over: Partial<BYOKCredential> = {}): BYOKCredential =>
        ({ id: 'c1', provider: 'openai', apiKey: 'k', ...over }) as BYOKCredential;

    it('managed credential → resolves iff the env-default LLM is reachable', () => {
        const managed = cred({ managed: true, apiKey: undefined });
        expect(isV2ModelResolvable({ model: 'm', credentialId: 'c1' }, managed, true)).toBe(true);
        expect(isV2ModelResolvable({ model: 'm', credentialId: 'c1' }, managed, false)).toBe(false);
    });

    it('real BYOK credential → resolves iff provider + model + usable material', () => {
        expect(isV2ModelResolvable({ model: 'gpt-x', credentialId: 'c1' }, cred(), false)).toBe(true);
        // no apiKey → not resolvable
        expect(
            isV2ModelResolvable({ model: 'gpt-x', credentialId: 'c1' }, cred({ apiKey: undefined }), false),
        ).toBe(false);
        // no model name → not resolvable
        expect(isV2ModelResolvable({ model: '', credentialId: 'c1' }, cred(), false)).toBe(false);
    });

    it('missing model or credential → false', () => {
        expect(isV2ModelResolvable(null, cred(), true)).toBe(false);
        expect(isV2ModelResolvable({ model: 'm', credentialId: 'c1' }, null, true)).toBe(false);
    });
});

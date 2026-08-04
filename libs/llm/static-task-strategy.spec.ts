/**
 * StaticTaskStrategy — REQ-ROUTE-01 (Phase 4, plan 04-01).
 *
 * Exercises the resolver against in-memory v2 configs + the REAL provider
 * registry (no live keys): openai `gpt-*` reports structuredOutput 'json_schema';
 * anthropic `claude-*` reports structuredOutput 'none' but toolCalling 'native',
 * so it IS eligible for codeReview (structured output via tool use), prSummary
 * and conversation. Only a model with neither a native json_schema nor native
 * tool calling — or an unregistered provider — fails the codeReview gate. No
 * decryption anywhere — the apiKey values are opaque ciphertext placeholders the
 * resolver never touches.
 */
import '@libs/llm/providers'; // side-effect: self-register every provider module
import { StaticTaskStrategy } from './static-task-strategy';
import type { RequestContext } from './routing-strategy';
import type {
    BYOKConfig,
    BYOKCredential,
    BYOKModelConfig,
    BYOKRouting,
} from './byok-config';

const OA: BYOKCredential = { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' };
const AN: BYOKCredential = {
    id: 'c-an',
    provider: 'anthropic',
    apiKey: 'enc-an',
};
const MANAGED: BYOKCredential = {
    id: 'c-mg',
    provider: 'openai',
    managed: true,
};
const UNKNOWN: BYOKCredential = {
    id: 'c-uk',
    provider: 'totally-unknown-provider',
    apiKey: 'enc-uk',
};

const M = {
    A: { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
    B: { id: 'm-B', credentialId: 'c-oa', model: 'gpt-5-mini' },
    ANT: { id: 'm-ANT', credentialId: 'c-an', model: 'claude-3-5-sonnet' },
    MG: { id: 'm-MG', credentialId: 'c-mg', model: 'gpt-4o' },
    UK: { id: 'm-UK', credentialId: 'c-uk', model: 'whatever-1' },
} satisfies Record<string, BYOKModelConfig>;

const cfg = (
    routing: BYOKRouting,
    models: BYOKModelConfig[] = [M.A, M.B, M.ANT, M.MG, M.UK],
    credentials: BYOKCredential[] = [OA, AN, MANAGED, UNKNOWN],
): BYOKConfig => ({ version: 2, credentials, models, routing });

const NO_CTX: RequestContext = {};

describe('StaticTaskStrategy — REQ-ROUTE-01', () => {
    const strategy = new StaticTaskStrategy();

    describe('precedence: override > taskOverride > default', () => {
        it('routes to routing.taskOverrides[task] over the default', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ taskOverrides: { codeReview: 'm-B' }, defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-B');
        });

        it('falls to routing.defaultModelId when no taskOverride exists', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
        });

        it('lets a folder/repo override (by id) win over taskOverride and default', () => {
            const v = strategy.resolve(
                'codeReview',
                { override: { modelId: 'm-B' } },
                cfg({ taskOverrides: { codeReview: 'm-A' }, defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-B');
        });
    });

    describe('single fallback', () => {
        it('returns routing.fallbackModelId with reason "fallback" when the chosen tier fails the gate', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                // default is an unregistered provider → skipped;
                // fallback is openai (json_schema) → eligible.
                cfg({ defaultModelId: 'm-UK', fallbackModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
            expect(v.reason).toMatch(/fallback/i);
        });
    });

    describe('capability gate', () => {
        it('accepts anthropic (structuredOutput none) for codeReview via native tool calling', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                // anthropic default: structuredOutput 'none' BUT toolCalling
                // 'native' → structured output via tool use → eligible.
                cfg({ defaultModelId: 'm-ANT' }),
            );
            expect(v.modelId).toBe('m-ANT');
        });

        it('skips an ungateable candidate and records the reason', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ taskOverrides: { codeReview: 'm-UK' }, defaultModelId: 'm-A' }),
            );
            // unregistered-provider taskOverride skipped → falls to openai default.
            expect(v.modelId).toBe('m-A');
            expect(v.reason).toMatch(/not registered/i);
        });

        it('BLOCKS (modelId null) when no candidate can be gated', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg(
                    { defaultModelId: 'm-UK' },
                    [M.UK],
                    [UNKNOWN],
                ),
            );
            expect(v.modelId).toBeNull();
            expect(v.reason).toMatch(/not registered/i);
        });

        it('applies no requirement for prSummary (anthropic none is eligible)', () => {
            const v = strategy.resolve(
                'prSummary',
                NO_CTX,
                cfg({ defaultModelId: 'm-ANT' }),
            );
            expect(v.modelId).toBe('m-ANT');
        });

        it('requires native toolCalling for conversation (anthropic native is eligible)', () => {
            const v = strategy.resolve(
                'conversation',
                NO_CTX,
                cfg({ defaultModelId: 'm-ANT' }),
            );
            expect(v.modelId).toBe('m-ANT');
        });
    });

    describe('parent-task inheritance', () => {
        it('inherits the parent task modelId without consulting taskOverrides', () => {
            const v = strategy.resolve(
                'prSummary',
                { parentTask: 'codeReview', parentModelId: 'm-INHERITED' },
                cfg({ taskOverrides: { prSummary: 'm-A' }, defaultModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-INHERITED');
            expect(v.reason).toMatch(/inherit/i);
        });
    });

    describe('managed / unknown provider degrades (never throws)', () => {
        it('skips a managed credential and falls through', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ defaultModelId: 'm-MG', fallbackModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
        });

        it('skips a model whose provider is not registered', () => {
            const v = strategy.resolve(
                'codeReview',
                NO_CTX,
                cfg({ defaultModelId: 'm-UK', fallbackModelId: 'm-A' }),
            );
            expect(v.modelId).toBe('m-A');
        });

        it('never throws on a wholly unresolvable config', () => {
            expect(() =>
                strategy.resolve(
                    'codeReview',
                    NO_CTX,
                    cfg({ defaultModelId: 'm-UK' }, [M.UK], [UNKNOWN]),
                ),
            ).not.toThrow();
        });
    });

    describe('W1: legacy byokModel NAME override on a config (id-THEN-name)', () => {
        it('applies a NAME override onto the chosen slot and carries it in modelName', () => {
            const v = strategy.resolve(
                'codeReview',
                // 'gpt-5-mini' is NOT a models[] id → treat as a legacy model NAME.
                { override: { modelId: 'gpt-5-mini' } },
                cfg({ defaultModelId: 'm-A' }),
            );
            // Chosen slot = the default (m-A, openai credential); the NAME overrides
            // its model string; capability gate ran against the NAME.
            expect(v.modelId).toBe('m-A');
            expect(v.modelName).toBe('gpt-5-mini');
        });
    });
});

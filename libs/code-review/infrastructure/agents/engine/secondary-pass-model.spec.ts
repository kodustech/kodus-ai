/**
 * Unit tests for secondary-pass model resolution (BYOK-default policy).
 *
 * The platform seam is `buildPlatformModel` (libs/llm) — no inline createOpenAI
 * here — so the tests mock that seam and assert the orchestration order:
 * BYOK slot → platform model → getInternalModel.
 */
jest.mock('@libs/llm/byok-to-vercel', () => ({
    buildModelFromSlot: jest.fn(
        (slot: any) => ({ __byok: true, model: slot?.model }) as any,
    ),
    buildPlatformModel: jest.fn(
        (id: string) => ({ __platform: id }) as any,
    ),
    getInternalModel: jest.fn(() => ({ __internal: true })),
}));

import {
    isSecondaryByok,
    resolveSecondaryPassModel,
    SECONDARY_PASS_MODEL_ID,
} from './secondary-pass-model';
import {
    buildModelFromSlot,
    buildPlatformModel,
    getInternalModel,
} from '@libs/llm/byok-to-vercel';

const byok = {
    main: {
        provider: 'openai' as any,
        model: 'gpt-client',
        apiKey: 'enc',
    },
    fallback: {
        provider: 'openai' as any,
        model: 'gpt-fallback',
        apiKey: 'enc2',
    },
};

describe('resolveSecondaryPassModel — BYOK default', () => {
    const prevOpenAi = process.env.API_OPEN_AI_API_KEY;
    const prevBase = process.env.API_OPENAI_FORCE_BASE_URL;

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.API_OPENAI_FORCE_BASE_URL;
        process.env.API_OPEN_AI_API_KEY = 'sk-platform';
    });

    afterAll(() => {
        if (prevOpenAi === undefined) delete process.env.API_OPEN_AI_API_KEY;
        else process.env.API_OPEN_AI_API_KEY = prevOpenAi;
        if (prevBase === undefined) delete process.env.API_OPENAI_FORCE_BASE_URL;
        else process.env.API_OPENAI_FORCE_BASE_URL = prevBase;
    });

    it('prefers BYOK main even when platform OpenAI key is set', () => {
        const model = resolveSecondaryPassModel(byok as any);
        expect(buildModelFromSlot).toHaveBeenCalledWith(byok.main);
        expect(model).toEqual(
            expect.objectContaining({ __byok: true, model: 'gpt-client' }),
        );
        expect(buildPlatformModel).not.toHaveBeenCalled();
        expect(isSecondaryByok(byok as any)).toBe(true);
    });

    it('does NOT treat a legacy fallback-only blob (no main) as BYOK — degrades to platform', () => {
        // Single-model policy (04b-05): only the resolved `main` slot counts.
        // A blob carrying only a legacy `fallback` is not a resolved BYOK slot.
        const onlyFallback = { fallback: byok.fallback };
        const model = resolveSecondaryPassModel(onlyFallback as any);
        expect(isSecondaryByok(onlyFallback as any)).toBe(false);
        expect(buildModelFromSlot).not.toHaveBeenCalled();
        expect(model).toEqual({ __platform: SECONDARY_PASS_MODEL_ID });
    });

    it('uses platform gpt-5.4-mini when no BYOK (trial path)', () => {
        const model = resolveSecondaryPassModel(undefined);
        expect(buildPlatformModel).toHaveBeenCalledWith(SECONDARY_PASS_MODEL_ID);
        expect(model).toEqual({ __platform: SECONDARY_PASS_MODEL_ID });
        expect(isSecondaryByok(undefined)).toBe(false);
    });

    it('falls through to getInternalModel when no BYOK and no platform model', () => {
        // No platform key → buildPlatformModel returns null → last-resort internal.
        (buildPlatformModel as jest.Mock).mockReturnValueOnce(null);
        resolveSecondaryPassModel(undefined);
        expect(getInternalModel).toHaveBeenCalled();
    });
});

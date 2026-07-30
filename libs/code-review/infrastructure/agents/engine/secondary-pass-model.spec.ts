/**
 * Unit tests for secondary-pass model resolution (BYOK-default policy).
 */
const createOpenAIMock = jest.fn(() => {
    const factory = jest.fn((id: string) => ({ __platform: id }));
    return factory;
});

jest.mock('@ai-sdk/openai', () => ({
    createOpenAI: (opts: any) => createOpenAIMock(opts),
}));

jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn(
        (cfg: any, role: string) =>
            ({ __byok: true, role, model: cfg?.[role]?.model }) as any,
    ),
    getInternalModel: jest.fn(() => ({ __internal: true })),
}));

import {
    isSecondaryByok,
    resolveSecondaryPassModel,
    SECONDARY_PASS_MODEL_ID,
} from './secondary-pass-model';
import { byokToVercelModel, getInternalModel } from '@libs/llm/byok-to-vercel';

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
        expect(byokToVercelModel).toHaveBeenCalledWith(byok, 'main');
        expect(model).toEqual(
            expect.objectContaining({ __byok: true, role: 'main' }),
        );
        expect(createOpenAIMock).not.toHaveBeenCalled();
        expect(isSecondaryByok(byok as any)).toBe(true);
    });

    it('uses BYOK fallback when main is absent', () => {
        const onlyFallback = { fallback: byok.fallback };
        resolveSecondaryPassModel(onlyFallback as any);
        expect(byokToVercelModel).toHaveBeenCalledWith(onlyFallback, 'fallback');
        expect(isSecondaryByok(onlyFallback as any)).toBe(true);
    });

    it('uses platform gpt-5.4-mini when no BYOK (trial path)', () => {
        const model = resolveSecondaryPassModel(undefined);
        expect(createOpenAIMock).toHaveBeenCalled();
        expect(model).toEqual({ __platform: SECONDARY_PASS_MODEL_ID });
        expect(isSecondaryByok(undefined)).toBe(false);
    });

    it('falls through to getInternalModel when no BYOK and no platform key', () => {
        delete process.env.API_OPEN_AI_API_KEY;
        resolveSecondaryPassModel(undefined);
        expect(getInternalModel).toHaveBeenCalled();
    });
});

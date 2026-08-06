/**
 * Unit tests for secondary-pass model resolution (BYOK-default policy).
 *
 * Resolution is centralized: `resolveSecondaryPassModel` delegates to
 * `getInternalModel`, which owns the BYOK-vs-managed decision, the DeepSeek
 * default and the self-hosted env model. These tests mock that single seam and
 * assert the bare resolved slot is threaded through (or absent) correctly.
 */
jest.mock('@libs/llm/byok-to-vercel', () => ({
    getInternalModel: jest.fn(
        (slot: any) => (slot ? { __byok: true, model: slot?.model } : { __internal: true }) as any,
    ),
}));

import {
    isSecondaryByok,
    resolveSecondaryPassModel,
} from './secondary-pass-model';
import { getInternalModel } from '@libs/llm/byok-to-vercel';

const slot = {
    provider: 'openai' as any,
    model: 'gpt-client',
    apiKey: 'enc',
};

describe('resolveSecondaryPassModel — BYOK default', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('threads the resolved BYOK slot into getInternalModel', () => {
        const model = resolveSecondaryPassModel(slot as any);
        expect(getInternalModel).toHaveBeenCalledWith(slot);
        expect(model).toEqual(
            expect.objectContaining({ __byok: true, model: 'gpt-client' }),
        );
        expect(isSecondaryByok(slot as any)).toBe(true);
    });

    it('uses the managed default (DeepSeek / env) when no BYOK — trial path', () => {
        const model = resolveSecondaryPassModel(undefined);
        expect(getInternalModel).toHaveBeenCalledWith(undefined);
        expect(model).toEqual({ __internal: true });
        expect(isSecondaryByok(undefined)).toBe(false);
    });
});

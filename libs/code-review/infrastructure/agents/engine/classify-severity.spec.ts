import { LLM } from '@libs/llm/llm';
import {
    parseSeverityResponse,
    buildSeverityPrompt,
    DEFAULT_SEVERITY_FLAGS,
} from './severity-prompt';

// The prompt build + response parse live in severity-prompt (shared with the
// severity eval and tested there). Mock them so these tests pin classifySeverity's
// OWN job: input assembly (flags fallback, model threading) and fail-safe
// degradation — not the parsing.
jest.mock('./severity-prompt', () => ({
    DEFAULT_SEVERITY_FLAGS: { critical: true },
    buildSeverityPrompt: jest.fn(() => 'PROMPT'),
    parseSeverityResponse: jest.fn(),
}));

import { classifySeverity } from './classify-severity';

const parseMock = parseSeverityResponse as jest.Mock;
const buildMock = buildSeverityPrompt as jest.Mock;

/**
 * classifySeverity is a secondary pass: it must never take findings down with it.
 * On any failure (no model, a stuck call, an unparseable response) it degrades
 * to "everything medium" so the review still ships with a severity on each
 * suggestion, preserves partial responses, and routes the CLIENT's severity
 * criteria + BYOK model into the call.
 */
describe('classifySeverity — input assembly & fail-safe degradation', () => {
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks(); // isolate call history (jest.mock fns survive restoreAllMocks)
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue('llm text');
        parseMock.mockReturnValue({ classifications: new Map(), parseOk: true });
    });

    afterEach(() => jest.restoreAllMocks());

    it('returns an empty map WITHOUT calling the model when there are no suggestions', async () => {
        const out = await classifySeverity([]);
        expect(out.size).toBe(0);
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('returns the parsed classifications on a successful parse', async () => {
        const parsed = new Map<number, string>([
            [0, 'high'],
            [1, 'low'],
        ]);
        parseMock.mockReturnValue({ classifications: parsed, parseOk: true });

        const out = await classifySeverity([{}, {}] as any);

        expect(out).toBe(parsed);
    });

    it('preserves PARTIAL responses — only the indices the model actually returned', async () => {
        parseMock.mockReturnValue({
            classifications: new Map([[1, 'critical']]),
            parseOk: true,
        });

        const out = await classifySeverity([{}, {}, {}] as any);

        expect(out.has(0)).toBe(false); // caller keeps the agent severity there
        expect(out.get(1)).toBe('critical');
    });

    it('defaults EVERY suggestion to medium when the response has no parseable JSON', async () => {
        parseMock.mockReturnValue({ classifications: new Map(), parseOk: false });

        const out = await classifySeverity([{}, {}, {}] as any);

        expect([...out.entries()]).toEqual([
            [0, 'medium'],
            [1, 'medium'],
            [2, 'medium'],
        ]);
    });

    it('is fail-safe: an LLM error degrades every suggestion to medium (never drops findings)', async () => {
        runSpy.mockRejectedValue(new Error('model timeout'));

        const out = await classifySeverity([{}, {}] as any);

        expect([...out.values()]).toEqual(['medium', 'medium']);
    });

    it('uses the client custom severity flags when provided', async () => {
        const custom = { critical: false, high: true };
        const suggestions = [{}] as any;

        await classifySeverity(suggestions, { severity: { flags: custom } } as any);

        expect(buildMock).toHaveBeenCalledWith(suggestions, custom);
    });

    it('falls back to DEFAULT_SEVERITY_FLAGS when no flags are configured', async () => {
        const suggestions = [{}] as any;

        await classifySeverity(suggestions, undefined);

        expect(buildMock).toHaveBeenCalledWith(suggestions, DEFAULT_SEVERITY_FLAGS);
    });

    it('threads the BYOK slot and the org id into the model call', async () => {
        const slot = { provider: 'openai', model: 'x' } as any;

        await classifySeverity([{}] as any, undefined, slot, 'org-9');

        expect(runSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                byokConfig: slot,
                organizationId: 'org-9',
                user: 'PROMPT',
            }),
        );
    });

    it('parses the model text, coalescing a missing response to "" (never passes null to the parser)', async () => {
        await classifySeverity([{}] as any);
        expect(parseMock).toHaveBeenCalledWith('llm text');

        runSpy.mockResolvedValue(undefined as any);
        await classifySeverity([{}] as any);
        expect(parseMock).toHaveBeenCalledWith(''); // null/undefined response → '' guard
    });
});

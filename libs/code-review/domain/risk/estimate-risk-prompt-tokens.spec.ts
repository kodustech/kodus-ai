import { setImmediate as nextTurn } from 'node:timers/promises';
import { estimateTextTokens } from '@libs/llm/token-estimate';
import {
    ENCODING_CHARS_PER_TURN,
    estimateRiskPromptTokens,
} from './estimate-risk-prompt-tokens';

jest.mock('@libs/llm/token-estimate', () => ({
    estimateTextTokens: jest.fn((text: string) => text.length),
}));

beforeEach(() => jest.clearAllMocks());

it('uses the shared estimator unchanged for a small prompt', async () => {
    expect(await estimateRiskPromptTokens('system\nuser\nschema')).toBe(18);
    expect(estimateTextTokens).toHaveBeenCalledWith('system\nuser\nschema');
    expect(estimateTextTokens).toHaveBeenCalledTimes(1);
});

it('counts the entire large prompt with bounded calls and yields between them', async () => {
    const prompt = 'x'.repeat(450_001);
    let callsAtHeartbeat = 0;
    const heartbeat = nextTurn().then(() => {
        callsAtHeartbeat = jest.mocked(estimateTextTokens).mock.calls.length;
    });

    expect(await estimateRiskPromptTokens(prompt)).toBe(prompt.length);
    await heartbeat;
    const pieces = jest
        .mocked(estimateTextTokens)
        .mock.calls.map(([text]) => text);
    expect(pieces.join('')).toBe(prompt);
    for (const call of jest.mocked(estimateTextTokens).mock.calls) {
        expect(call).toEqual([expect.any(String), { cache: false }]);
    }
    expect(
        pieces.every((piece) => piece.length <= ENCODING_CHARS_PER_TURN),
    ).toBe(true);
    expect(callsAtHeartbeat).toBeGreaterThan(0);
    expect(callsAtHeartbeat).toBeLessThan(pieces.length);
});

it('does not split a Unicode surrogate pair between encoding calls', async () => {
    const prompt = `${'x'.repeat(ENCODING_CHARS_PER_TURN - 1)}😀${'y'.repeat(ENCODING_CHARS_PER_TURN + 6000)}`;
    await estimateRiskPromptTokens(prompt);
    const pieces = jest
        .mocked(estimateTextTokens)
        .mock.calls.map(([text]) => text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(prompt);
    expect(
        pieces.every(
            (piece) =>
                !/[\uD800-\uDBFF]$/.test(piece) &&
                !/^[\uDC00-\uDFFF]/.test(piece),
        ),
    ).toBe(true);
});

import { setImmediate as nextTurn } from 'node:timers/promises';
import { estimateTextTokens } from '@libs/llm/token-estimate';
import { estimateRiskPromptTokens } from './estimate-risk-prompt-tokens';

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
    expect(pieces.every((piece) => piece.length <= 200_000)).toBe(true);
    expect(callsAtHeartbeat).toBeGreaterThan(0);
    expect(callsAtHeartbeat).toBeLessThan(pieces.length);
});

it('does not split a Unicode surrogate pair between encoding calls', async () => {
    const prompt = `${'x'.repeat(63_999)}😀${'y'.repeat(70_000)}`;
    await estimateRiskPromptTokens(prompt);
    const pieces = jest
        .mocked(estimateTextTokens)
        .mock.calls.map(([text]) => text);
    expect(pieces.join('')).toBe(prompt);
    expect(
        pieces.every(
            (piece) =>
                !/[\uD800-\uDBFF]$/.test(piece) &&
                !/^[\uDC00-\uDFFF]/.test(piece),
        ),
    ).toBe(true);
});

import { addTokens, finishedLine, newTally } from './run-log';
it('keeps measured counters and explicitly marks partial/unknown provider usage instead of counting a reservation as actual usage', () => {
    const tally = newTally();
    addTokens(tally, {
        inputTokens: 7,
        outputTokens: 3,
        measurement: 'partial',
    } as any);
    addTokens(tally, {
        inputTokens: 0,
        outputTokens: 0,
        measurement: 'unknown',
    } as any);
    expect(
        finishedLine(
            { runId: 'r', attempt: 1, organizationId: 'o', correlationId: 'c' },
            { state: 'partly_tested' },
            tally,
        ),
    ).toMatchObject({
        inputTokens: 7,
        outputTokens: 3,
        tokenMeasurement: 'partial',
    });
});
it('does not add a partial marker to legacy complete measured usage', () => {
    const tally = newTally();
    addTokens(tally, { inputTokens: 7, outputTokens: 3 });
    expect(
        finishedLine(
            { runId: 'r', attempt: 1, organizationId: 'o', correlationId: 'c' },
            { state: 'partly_tested' },
            tally,
        ),
    ).not.toHaveProperty('tokenMeasurement');
});

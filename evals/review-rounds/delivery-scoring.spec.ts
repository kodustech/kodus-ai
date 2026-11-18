jest.mock('../investigation/recall-judge', () => ({
    matchComment: jest.fn().mockResolvedValue(true),
}));

const { scoreDeliveredClaims } = require('./run');

describe('review delivery across agents', () => {
    const claim = { id: 'registration', ruleId: 'register', golden: 'Worker is unregistered' };
    const comments = [{ text: 'Worker is unregistered', brokenKodyRulesIds: [] }];

    it.each([
        ['deliver', false, true],
        ['not_deliver', false, false],
        ['deliver', true, false],
    ])('scores %s with rule-specific attribution %s as %s', async (expectation, ruleSpecific, pass) => {
        const result = await scoreDeliveredClaims(
            { claims: [{ ...claim, expect: expectation }] }, comments, '', ruleSpecific,
        );
        expect(result[0].pass).toBe(pass);
    });
});

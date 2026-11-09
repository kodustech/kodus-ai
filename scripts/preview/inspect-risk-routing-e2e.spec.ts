const { executionEvidence } = require('./inspect-risk-routing-e2e.cjs');
it('exports only machine decisions, omitting free-form nested evidence', () => {
    const secret = 'canary-private-provider-token';
    const data = executionEvidence({
        uuid: '00000000-0000-4000-8000-000000000001',
        status: 'success',
        heavy: true,
        errorMessage: secret,
        prompt: secret,
        risk: {
            status: 'assessed',
            riskIdentified: true,
            reason: secret,
            failure: { message: secret },
        },
        decision: { kind: 'hold', reason: secret, toolOutput: secret },
        eligibility: {
            [secret]: { key: secret, status: 'eligible', reason: secret },
        },
        agentSkips: [{ id: 'qa-risk-watch', reason: secret }],
    });
    expect(data).toMatchObject({
        status: 'success',
        heavy: true,
        risk: { status: 'assessed', riskIdentified: true },
        decision: { kind: 'hold' },
    });
    expect(JSON.stringify(data)).not.toContain(secret);
    expect(Object.values(data.eligibility)[0]).toMatchObject({
        status: 'eligible',
        key: expect.any(String),
    });
});

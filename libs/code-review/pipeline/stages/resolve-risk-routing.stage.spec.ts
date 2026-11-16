import { ResolveRiskRoutingStage } from './resolve-risk-routing.stage';

const configuration = {
    resolveReviewRouting: jest.fn(async (context) => context),
};
const stage = new ResolveRiskRoutingStage(configuration as any);
const agent = {
    id: 'agent',
    name: 'Risk check',
    enabled: true,
    runWhen: 'risk-found',
};

beforeEach(() => jest.clearAllMocks());

it('records why a conditional agent is skipped before file-based early exits, without routing work when off', async () => {
    const result = await stage.execute({
        codeReviewConfig: {
            riskAssessmentActive: false,
            customAgents: [agent],
        },
        riskAssessment: { status: 'disabled' },
    } as any);
    expect(result.customAgentRiskSkips).toEqual([
        { id: 'agent', reason: 'risk-disabled' },
    ]);
    expect(configuration.resolveReviewRouting).not.toHaveBeenCalled();
});

it('does not record a manual run as risk-skipped', async () => {
    const result = await stage.execute({
        codeReviewConfig: { customAgents: [{ ...agent, enabled: false }] },
        onlyCustomAgent: 'risk-check',
    } as any);
    expect(result.customAgentRiskSkips).toEqual([]);
});

it('resolves review routing after the assessment and preserves the shared result for agent selection', async () => {
    const context = {
        codeReviewConfig: { riskAssessmentActive: true, customAgents: [agent] },
        riskAssessment: { status: 'assessed', riskIdentified: true },
    } as any;
    const result = await stage.execute(context);
    expect(configuration.resolveReviewRouting).toHaveBeenCalledWith(context);
    expect(result.customAgentRiskSkips).toEqual([]);
    expect(result.riskAssessment).toEqual(context.riskAssessment);
});

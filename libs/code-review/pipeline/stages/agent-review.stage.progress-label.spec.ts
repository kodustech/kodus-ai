import { AgentReviewStage } from './agent-review.stage';

// The label and stage name are pure functions of the event; no collaborator
// is touched, so the stage is built without its constructor.
const stage = Object.create(AgentReviewStage.prototype) as any;
const names = new Map([['ledger-rules', 'Ledger Rules']]);

describe('AgentReviewStage — agent timeline labels', () => {
    it('labels a custom agent by its name and gives it its own entry', () => {
        const event = {
            agentName: 'kodus-custom-agent-ledger-rules',
            agentCategory: 'custom_agent',
            status: 'started',
        };
        expect(stage.formatAgentLabel(event, names)).toBe(
            'Ledger Rules — investigating...',
        );
        expect(stage.getAgentStageName(event)).toBe(
            'AgentReview::custom-agent-ledger-rules',
        );
    });

    it('falls back to the slug when the name is unknown', () => {
        expect(
            stage.formatAgentLabel(
                {
                    agentName: 'kodus-custom-agent-api-contracts',
                    agentCategory: 'custom_agent',
                    status: 'completed',
                    findings: 2,
                },
                names,
            ),
        ).toBe('api-contracts — 2 findings ');
    });

    it('keeps the built-in agent labels', () => {
        const event = {
            agentName: 'kodus-generalist-review-agent',
            agentCategory: 'generalist',
            status: 'started',
        };
        expect(stage.formatAgentLabel(event, names)).toBe(
            'Generalist Agent — investigating...',
        );
        expect(stage.getAgentStageName(event)).toBe('AgentReview::generalist');
        expect(
            stage.formatAgentLabel({
                agentName: 'kodus-performance-review-agent',
                agentCategory: 'performance',
                status: 'started',
            }),
        ).toBe('Performance Agent — investigating...');
    });
});

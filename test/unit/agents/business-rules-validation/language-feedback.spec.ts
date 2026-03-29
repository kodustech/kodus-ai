import { buildBusinessRulesContractViolationFeedback } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/contract-feedback.builder';
import {
    buildMcpConnectionFailureFeedback,
    buildRequiredMcpFeedback,
} from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/required-mcp-feedback';

describe('business-rules language feedback', () => {
    it('keeps required MCP feedback as a language-neutral internal message', () => {
        const feedback = buildRequiredMcpFeedback({
            userLanguage: 'pt-BR',
            requiredMcps: [
                {
                    category: 'task-management',
                    label: 'Task Management',
                    examples: 'Jira, Linear',
                },
            ],
            availableProviders: ['github'],
        });

        expect(feedback).toContain('## 🔌 MCP Integration Required');
        expect(feedback).toContain(
            'Business validation compares the PR implementation with task/ticket requirements.',
        );
        expect(feedback).toContain('### Next steps');
    });

    it('keeps MCP connection failure feedback as a language-neutral internal message', () => {
        const feedback = buildMcpConnectionFailureFeedback({
            userLanguage: 'pt-BR',
            availableProviders: ['jira'],
        });

        expect(feedback).toContain('## ⚠️ MCP Connection Failed');
        expect(feedback).toContain(
            "MCP integrations are configured, but I couldn't connect to any provider right now.",
        );
        expect(feedback).toContain('### Next steps');
    });

    it('keeps contract violation feedback as a language-neutral internal message', () => {
        const feedback = buildBusinessRulesContractViolationFeedback(
            'pt-BR',
            'input',
            ['prepareContext.pullRequest.pullRequestNumber'],
        );

        expect(feedback).toContain('## ⚠️ Missing Validation Context');
        expect(feedback).toContain("I couldn't start the skill");
        expect(feedback).toContain('### How to fix');
    });
});

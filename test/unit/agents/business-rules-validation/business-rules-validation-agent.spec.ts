import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent';
import { BaseAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/base-agent.provider';

function createProvider(): BusinessRulesValidationAgentProvider {
    return new BusinessRulesValidationAgentProvider(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
    );
}

describe('BusinessRulesValidationAgentProvider parser', () => {
    it('parses nested final_answer content from analyzer response', () => {
        const provider = createProvider();

        const payload = JSON.stringify({
            reasoning: 'Stopping due to limit/error.',
            action: {
                type: 'final_answer',
                content:
                    '```json\n{"needsMoreInfo":false,"summary":"## Business Rules Validation\\n\\nAll checks passed."}\n```',
            },
        });

        const parsed = (provider as any).parseValidationResult(payload);

        expect(parsed.needsMoreInfo).toBe(false);
        expect(parsed.summary).toContain('Business Rules Validation');
    });

    it('accepts direct markdown validation summary when structured JSON is missing', () => {
        const provider = createProvider();

        const payload = `## Business Rules Validation

**Status:** Compliant
**Analysis Confidence:** high

---
*Analysis performed by Kodus AI Business Rules Validator*`;

        const parsed = (provider as any).parseValidationResult(payload);

        expect(parsed.needsMoreInfo).toBe(false);
        expect(parsed.summary).toContain('Status');
    });

    it('accepts direct markdown limitation summaries without strict english keywords', () => {
        const provider = createProvider();

        const payload = `## ⚠️ Missing Validation Context

I couldn't start the skill because required context fields are missing.`;

        const parsed = (provider as any).parseValidationResult(payload);

        expect(parsed.needsMoreInfo).toBe(true);
        expect(parsed.summary).toContain('Missing Validation Context');
    });

    it('parses JSON fenced payload even when surrounded by additional text', () => {
        const provider = createProvider();

        const payload = `Analyzer output below:

\`\`\`json
{"needsMoreInfo":false,"summary":"## Business Rules Validation\\n\\nAll checks passed."}
\`\`\`

End of message.`;

        const parsed = (provider as any).parseValidationResult(payload);

        expect(parsed.needsMoreInfo).toBe(false);
        expect(parsed.summary).toContain('All checks passed');
    });

    it('parses explicit limitation metadata when analyzer returns a needs-more-info payload', () => {
        const provider = createProvider();

        const payload = JSON.stringify({
            needsMoreInfo: true,
            mode: 'limitation_response',
            reason: 'task_context_weak',
            taskContextStatus: 'weak',
            prDiffStatus: 'usable',
            missingInfo: '## 🤔 Insufficient Task Context',
            summary: '## 🤔 Insufficient Task Context',
        });

        const parsed = (provider as any).parseValidationResult(payload);

        expect(parsed).toMatchObject({
            needsMoreInfo: true,
            mode: 'limitation_response',
            reason: 'task_context_weak',
            taskContextStatus: 'weak',
            prDiffStatus: 'usable',
            summary: '## 🤔 Insufficient Task Context',
        });
    });
});

describe('BusinessRulesValidationAgentProvider.withTimeout', () => {
    it('resolves when promise completes before timeout', async () => {
        const provider = createProvider();
        const result = await (provider as any).withTimeout(
            Promise.resolve('ok'),
            5000,
            'test-resolve',
        );
        expect(result).toBe('ok');
    });

    it('rejects with timeout error when promise exceeds timeout', async () => {
        const provider = createProvider();
        let timeoutId: NodeJS.Timeout | undefined;
        const slow = new Promise((resolve) => {
            timeoutId = setTimeout(resolve, 10_000);
        });
        await expect(
            (provider as any).withTimeout(slow, 50, 'test-timeout'),
        ).rejects.toThrow('Timeout after 50ms in test-timeout');
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    });

    it('clears the timer after resolution to avoid leaks', async () => {
        const provider = createProvider();
        const clearSpy = jest.spyOn(global, 'clearTimeout');
        await (provider as any).withTimeout(
            Promise.resolve('done'),
            5000,
            'test-clear',
        );
        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });
});

describe('BusinessRulesValidationAgentProvider.isParserFallback', () => {
    it('returns true when needsMoreInfo is true and missingInfo contains parser error', () => {
        const provider = createProvider();
        const result = (provider as any).isParserFallback({
            needsMoreInfo: true,
            missingInfo: 'Error parsing validation result from LLM',
            summary: '',
        });
        expect(result).toBe(true);
    });

    it('returns false when needsMoreInfo is false', () => {
        const provider = createProvider();
        const result = (provider as any).isParserFallback({
            needsMoreInfo: false,
            missingInfo: 'error parsing validation result',
            summary: 'ok',
        });
        expect(result).toBe(false);
    });

    it('returns false when missingInfo does not contain parser error message', () => {
        const provider = createProvider();
        const result = (provider as any).isParserFallback({
            needsMoreInfo: true,
            missingInfo: 'Missing acceptance criteria',
            summary: '',
        });
        expect(result).toBe(false);
    });

    it('returns false when missingInfo is undefined', () => {
        const provider = createProvider();
        const result = (provider as any).isParserFallback({
            needsMoreInfo: true,
            summary: '',
        });
        expect(result).toBe(false);
    });
});

describe('BusinessRulesValidationAgentProvider.formatValidationResponse', () => {
    it('formats limitation responses through the user-facing formatter', async () => {
        const provider = createProvider();
        (provider as any).formatUserFacingMessage = jest
            .fn()
            .mockResolvedValue('## 🤔 Preciso de mais contexto');

        const formatted = await (provider as any).formatValidationResponse(
            {
                needsMoreInfo: true,
                mode: 'limitation_response',
                summary: '## 🤔 Need Task Information',
                missingInfo: 'legacy field',
            },
            {
                userLanguage: 'pt-BR',
            },
        );

        expect((provider as any).formatUserFacingMessage).toHaveBeenCalledWith(
            '## 🤔 Need Task Information',
            'pt-BR',
            'limitation',
        );
        expect(formatted).toBe('## 🤔 Preciso de mais contexto');
    });

    it('formats early feedback through the same user-facing formatter', async () => {
        const provider = createProvider();
        (provider as any).formatUserFacingMessage = jest
            .fn()
            .mockResolvedValue('## 🔌 Integracao MCP Necessaria');

        const formatted = await (provider as any).formatExecutionFeedback({
            userLanguage: 'pt-BR',
            context: {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
            },
            feedback: '## 🔌 MCP Integration Required',
        });

        expect((provider as any).formatUserFacingMessage).toHaveBeenCalledWith(
            '## 🔌 MCP Integration Required',
            'pt-BR',
            'feedback',
        );
        expect(formatted).toBe('## 🔌 Integracao MCP Necessaria');
    });

    it('appends diagnostic details on analyzer failure limitations', async () => {
        const provider = createProvider();
        (provider as any).formatUserFacingMessage = jest
            .fn()
            .mockImplementation(async (message: string) => message);

        const formatted = await (provider as any).formatValidationResponse(
            {
                needsMoreInfo: true,
                mode: 'limitation_response',
                reason: 'analyzer_failure',
                summary:
                    '❌ **Error processing validation**\n\nAn error occurred while processing the system response. Please try again.',
                missingInfo:
                    'Analyzer execution failed: Timeout after 120000ms in business-rules-analyzer-attempt-1',
            },
            {
                userLanguage: 'en-US',
            },
        );

        expect(formatted).toContain('### Details');
        expect(formatted).toContain('Analyzer execution failed: Timeout');
    });
});

describe('BusinessRulesValidationAgentProvider analyzer execution', () => {
    it('awaits async formatting before writing formattedResponse into context', async () => {
        const createLLMAdapterSpy = jest
            .spyOn(BaseAgentProvider.prototype as any, 'createLLMAdapter')
            .mockReturnValue({} as any);
        const provider = new BusinessRulesValidationAgentProvider(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {
                getExecutionPolicy: jest.fn(() => ({
                    analyzerTimeoutMs: 5_000,
                    analyzerMaxIterations: 1,
                })),
                getAnalyzerInstructions: jest.fn(
                    () => 'SYSTEM SKILL INSTRUCTIONS',
                ),
            } as any,
            {
                recordCounter: jest.fn(),
                recordHistogram: jest.fn(),
            } as any,
        );

        (provider as any).executeAnalyzerWithRetries = jest
            .fn()
            .mockResolvedValue({
                needsMoreInfo: false,
                summary: '## Business Rules Validation',
            });
        (provider as any).formatValidationResponse = jest
            .fn()
            .mockResolvedValue('## Business Rules Validation');

        const result = await (provider as any).runAnalyzer({} as any, {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            taskQuality: 'COMPLETE',
            analysisEligibility: {
                mode: 'full_analysis',
                reason: 'analysis_ready',
                taskContextStatus: 'usable',
                prDiffStatus: 'usable',
            },
        });

        expect(result.formattedResponse).toBe('## Business Rules Validation');
        expect(result.formattedResponse).not.toBeInstanceOf(Promise);
        createLLMAdapterSpy.mockRestore();
    });

    it('parses analyzer JSON and applies eligibility defaults from the pipeline context', () => {
        const metricsCollector = {
            recordCounter: jest.fn(),
            recordHistogram: jest.fn(),
        };
        const provider = new BusinessRulesValidationAgentProvider(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {
                getExecutionPolicy: jest.fn(() => ({
                    analyzerTimeoutMs: 5_000,
                    analyzerMaxIterations: 1,
                })),
                getAnalyzerInstructions: jest.fn(
                    () => 'SYSTEM SKILL INSTRUCTIONS',
                ),
            } as any,
            metricsCollector as any,
        );

        const ctx = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'pt-BR',
            taskQuality: 'COMPLETE',
            taskContext:
                'Task ID: KC-1441\n\nTitle: Replace any-based git change parsing with typed handling\n\nDescription:\nThe PR should remove unsafe any usage from git change collection and preserve command behavior.\n\nAcceptance Criteria:\n- Git change parsing no longer relies on any',
            taskContextNormalized: {
                id: 'KC-1441',
                title: 'Replace any-based git change parsing with typed handling',
                description:
                    'The PR should remove unsafe any usage from git change collection and preserve command behavior.',
                acceptanceCriteria: [
                    'Git change parsing no longer relies on any',
                ],
            },
            prDiff: 'diff --git a/src/commands/prCommentCommands.ts b/src/commands/prCommentCommands.ts\n+ changeGroups.forEach((change: GitChangeLike) => {\n',
            analysisEligibility: {
                mode: 'full_analysis',
                reason: 'analysis_ready',
                taskContextStatus: 'usable',
                prDiffStatus: 'usable',
            },
        };

        const parsed = (provider as any).parseValidationResult(
            '```json\n{"needsMoreInfo":false,"summary":"## Validação de Regras de Negócio\\n\\nTudo certo."}\n```',
        );
        const result = (provider as any).applyValidationDefaults(parsed, ctx);

        expect(result).toMatchObject({
            needsMoreInfo: false,
            mode: 'full_analysis',
            reason: 'analysis_ready',
            taskContextStatus: 'usable',
            prDiffStatus: 'usable',
            confidence: 'medium',
            summary: '## Validação de Regras de Negócio\n\nTudo certo.',
        });
        expect(metricsCollector.recordCounter).not.toHaveBeenCalled();
    });
});

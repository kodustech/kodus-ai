import { ReviewOrchestratorService } from '@/code-review/infrastructure/agents/review-orchestrator.service';
import { CodeSuggestion } from '@/core/infrastructure/config/types/general/codeReview.type';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('ReviewOrchestratorService', () => {
    let orchestrator: ReviewOrchestratorService;
    let mockBugAgent: any;
    let mockSecurityAgent: any;
    let mockPerformanceAgent: any;
    let mockGeneralistAgent: any;

    const makeOutput = (
        agentName: string,
        suggestions: Partial<CodeSuggestion>[],
    ) => ({
        suggestions,
        agentName,
        turnsUsed: 3,
        durationMs: 1000,
    });

    const baseInput = {
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'team-1',
        } as any,
        changedFiles: [{ filename: 'src/index.ts', patch: '+code' } as any],
        remoteCommands: {
            grep: jest.fn(),
            read: jest.fn(),
            listDir: jest.fn(),
        },
        prNumber: 42,
        repositoryFullName: 'org/repo',
        languageResultPrompt: 'en-US',
    };

    beforeEach(() => {
        mockBugAgent = {
            execute: jest.fn().mockResolvedValue(
                makeOutput('bug-agent', [
                    {
                        relevantFile: 'src/index.ts',
                        suggestionContent: 'Bug found',
                        label: 'bug',
                        severity: 'high',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                ]),
            ),
        };

        mockSecurityAgent = {
            execute: jest.fn().mockResolvedValue(
                makeOutput('security-agent', [
                    {
                        relevantFile: 'src/index.ts',
                        suggestionContent: 'XSS vulnerability',
                        label: 'security',
                        severity: 'critical',
                        relevantLinesStart: 20,
                        relevantLinesEnd: 25,
                    },
                ]),
            ),
        };

        mockPerformanceAgent = {
            execute: jest.fn().mockResolvedValue(
                makeOutput('performance-agent', [
                    {
                        relevantFile: 'src/index.ts',
                        suggestionContent: 'N+1 query',
                        label: 'performance',
                        severity: 'medium',
                        relevantLinesStart: 50,
                        relevantLinesEnd: 55,
                    },
                ]),
            ),
        };

        mockGeneralistAgent = {
            execute: jest.fn().mockResolvedValue(
                makeOutput('generalist-agent', [
                    {
                        relevantFile: 'src/index.ts',
                        suggestionContent: 'Generalist finding',
                        label: 'bug',
                        severity: 'high',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                ]),
            ),
        };

        orchestrator = new ReviewOrchestratorService(
            mockBugAgent,
            mockSecurityAgent,
            mockPerformanceAgent,
            mockGeneralistAgent,
        );
    });

    describe('agent dispatch', () => {
        it('should dispatch the generalist agent in normal mode', async () => {
            const result = await orchestrator.execute({
                ...baseInput,
                reviewMode: 'normal',
                reviewOptions: { bug: true, security: true, performance: true },
            });

            expect(mockGeneralistAgent.execute).toHaveBeenCalledTimes(1);
            expect(mockBugAgent.execute).not.toHaveBeenCalled();
            expect(mockSecurityAgent.execute).not.toHaveBeenCalled();
            expect(mockPerformanceAgent.execute).not.toHaveBeenCalled();
            expect(result.suggestions).toHaveLength(1);
            expect(result.agentResults).toHaveLength(1);
        });

        it('should dispatch all agents when all categories enabled', async () => {
            const result = await orchestrator.execute({
                ...baseInput,
                reviewMode: 'deep',
                reviewOptions: { bug: true, security: true, performance: true },
            });

            expect(mockBugAgent.execute).toHaveBeenCalledTimes(1);
            expect(mockSecurityAgent.execute).toHaveBeenCalledTimes(1);
            expect(mockPerformanceAgent.execute).toHaveBeenCalledTimes(1);
            expect(result.suggestions).toHaveLength(3);
            expect(result.agentResults).toHaveLength(3);
        });

        it('should skip disabled categories', async () => {
            const result = await orchestrator.execute({
                ...baseInput,
                reviewMode: 'deep',
                reviewOptions: {
                    bug: true,
                    security: false,
                    performance: false,
                },
            });

            expect(mockBugAgent.execute).toHaveBeenCalledTimes(1);
            expect(mockSecurityAgent.execute).not.toHaveBeenCalled();
            expect(mockPerformanceAgent.execute).not.toHaveBeenCalled();
            expect(result.suggestions).toHaveLength(1);
        });

        it('should return empty results when no categories enabled', async () => {
            const result = await orchestrator.execute({
                ...baseInput,
                reviewOptions: {
                    bug: false,
                    security: false,
                    performance: false,
                },
            });

            expect(result.suggestions).toHaveLength(0);
            expect(result.agentResults).toHaveLength(0);
        });

        it('should handle agent failures gracefully', async () => {
            mockSecurityAgent.execute.mockRejectedValue(
                new Error('LLM timeout'),
            );

            const result = await orchestrator.execute({
                ...baseInput,
                reviewMode: 'deep',
                reviewOptions: { bug: true, security: true, performance: true },
            });

            // Bug and performance should succeed, security should fail
            expect(result.agentResults).toHaveLength(2);
            expect(result.suggestions.length).toBeGreaterThan(0);
        });
    });

    describe('deduplication', () => {
        it('should deduplicate overlapping suggestions from different agents, keeping higher severity', async () => {
            // Both bug and security agents find issue on same lines
            mockBugAgent.execute.mockResolvedValue(
                makeOutput('bug-agent', [
                    {
                        relevantFile: 'src/auth.ts',
                        suggestionContent: 'Missing null check',
                        label: 'bug',
                        severity: 'medium',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                ]),
            );
            mockSecurityAgent.execute.mockResolvedValue(
                makeOutput('security-agent', [
                    {
                        relevantFile: 'src/auth.ts',
                        suggestionContent: 'Auth bypass',
                        label: 'security',
                        severity: 'critical',
                        relevantLinesStart: 12,
                        relevantLinesEnd: 14,
                    },
                ]),
            );
            mockPerformanceAgent.execute.mockResolvedValue(
                makeOutput('performance-agent', []),
            );

            const result = await orchestrator.execute({
                ...baseInput,
                reviewMode: 'deep',
                reviewOptions: { bug: true, security: true, performance: true },
            });

            // Deterministic dedup was removed — both are kept since they
            // have different categories (bug vs security). LLM dedup in
            // AgentReviewStage handles semantic dedup downstream.
            expect(result.suggestions).toHaveLength(2);
        });

        it('should NOT deduplicate suggestions on different lines in same file', async () => {
            mockBugAgent.execute.mockResolvedValue(
                makeOutput('bug-agent', [
                    {
                        relevantFile: 'src/index.ts',
                        suggestionContent: 'Bug on line 10',
                        label: 'bug',
                        severity: 'high',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 12,
                    },
                ]),
            );
            mockSecurityAgent.execute.mockResolvedValue(
                makeOutput('security-agent', [
                    {
                        relevantFile: 'src/index.ts',
                        suggestionContent: 'Security on line 50',
                        label: 'security',
                        severity: 'high',
                        relevantLinesStart: 50,
                        relevantLinesEnd: 55,
                    },
                ]),
            );
            mockPerformanceAgent.execute.mockResolvedValue(
                makeOutput('performance-agent', []),
            );

            const result = await orchestrator.execute({
                ...baseInput,
                reviewMode: 'deep',
                reviewOptions: { bug: true, security: true, performance: true },
            });

            expect(result.suggestions).toHaveLength(2);
        });

        it('should NOT deduplicate suggestions in different files', async () => {
            mockBugAgent.execute.mockResolvedValue(
                makeOutput('bug-agent', [
                    {
                        relevantFile: 'src/a.ts',
                        label: 'bug',
                        severity: 'high',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                ]),
            );
            mockSecurityAgent.execute.mockResolvedValue(
                makeOutput('security-agent', [
                    {
                        relevantFile: 'src/b.ts',
                        label: 'security',
                        severity: 'critical',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                ]),
            );
            mockPerformanceAgent.execute.mockResolvedValue(
                makeOutput('performance-agent', []),
            );

            const result = await orchestrator.execute({
                ...baseInput,
                reviewMode: 'deep',
                reviewOptions: { bug: true, security: true, performance: true },
            });

            expect(result.suggestions).toHaveLength(2);
        });

        it('should handle suggestions without line numbers (no dedup)', async () => {
            mockBugAgent.execute.mockResolvedValue(
                makeOutput('bug-agent', [
                    {
                        relevantFile: 'src/index.ts',
                        label: 'bug',
                        severity: 'high',
                    },
                ]),
            );
            mockSecurityAgent.execute.mockResolvedValue(
                makeOutput('security-agent', [
                    {
                        relevantFile: 'src/index.ts',
                        label: 'security',
                        severity: 'critical',
                    },
                ]),
            );
            mockPerformanceAgent.execute.mockResolvedValue(
                makeOutput('performance-agent', []),
            );

            const result = await orchestrator.execute({
                ...baseInput,
                reviewMode: 'deep',
                reviewOptions: { bug: true, security: true, performance: true },
            });

            // No dedup when lines are missing
            expect(result.suggestions).toHaveLength(2);
        });
    });
});

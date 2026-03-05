import { buildBusinessRulesAnalysisPrompt } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/analysis-prompt.builder';
import { BusinessRulesContext } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/types';

describe('buildBusinessRulesAnalysisPrompt', () => {
    it('renders a fallback marker when the PR diff is an empty string', () => {
        const prompt = buildBusinessRulesAnalysisPrompt({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            taskQuality: 'COMPLETE',
            taskContext:
                'Task ID: 15604\n\nTitle: Kody rules por time\n\nDescription: Review billing lookup by team.',
            prDiff: '',
            prBody: '',
        } as BusinessRulesContext);

        expect(prompt).toContain('PR_DIFF:\n(not available)');
        expect(prompt).toContain('PR_DESCRIPTION:\n(not available)');
    });

    it('uses the configured user language in the analyzer prompt', () => {
        const prompt = buildBusinessRulesAnalysisPrompt({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'pt-BR',
            taskQuality: 'COMPLETE',
            taskContext: 'Task context',
            prDiff: 'diff --git a/file.ts b/file.ts',
            prBody: 'PR body',
        } as BusinessRulesContext);

        expect(prompt).toContain('USER LANGUAGE: pt-BR');
    });

    it('adds strict language instructions so generated prose follows USER LANGUAGE', () => {
        const prompt = buildBusinessRulesAnalysisPrompt({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'pt-BR',
            taskQuality: 'PARTIAL',
            taskContext: 'Contexto da task',
            prDiff: 'diff --git a/file.ts b/file.ts',
            prBody: 'PR body',
        } as BusinessRulesContext);

        expect(prompt).toContain('Write ALL generated prose in USER LANGUAGE.');
        expect(prompt).toContain(
            'Only requirement quotes copied from task context may remain in the original source language.',
        );
        expect(prompt).toContain(
            'Do not mix languages in headings, status labels, findings, explanations, or suggested actions.',
        );
    });

    it('includes task links when normalized task context provides them', () => {
        const prompt = buildBusinessRulesAnalysisPrompt({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            taskQuality: 'COMPLETE',
            taskContext: 'Task context',
            taskContextNormalized: {
                id: 'KC-1441',
                title: 'Kody rules por time',
                links: ['https://kodustech.atlassian.net/browse/KC-1441'],
            },
            prDiff: 'diff --git a/file.ts b/file.ts',
            prBody: 'PR body',
        } as BusinessRulesContext);

        expect(prompt).toContain('TASK_LINKS:');
        expect(prompt).toContain(
            'https://kodustech.atlassian.net/browse/KC-1441',
        );
    });

    it('falls back to en-US when user language is missing', () => {
        const prompt = buildBusinessRulesAnalysisPrompt({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            taskQuality: 'COMPLETE',
            taskContext: 'Task context',
            prDiff: 'diff --git a/file.ts b/file.ts',
            prBody: 'PR body',
        } as BusinessRulesContext);

        expect(prompt).toContain('USER LANGUAGE: en-US');
    });
});

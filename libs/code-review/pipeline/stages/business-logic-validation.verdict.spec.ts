import { Test, TestingModule } from '@nestjs/testing';

import { BusinessLogicValidationStage } from './business-logic-validation.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/agents/business-rules-validation/businessRulesValidationAgent';
import type { ValidationResult } from '@libs/agents/infrastructure/services/agents/business-rules-validation/types';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';

/**
 * #2019 — the outcome of a validation is the verdict the analyzer returned,
 * not a keyword match over the markdown report. A compliant PR whose report is
 * written in any language must be recorded as a pass; a report whose prose
 * happens to contain "no issues" must still be a gap when the verdict says so.
 */
describe('BusinessLogicValidationStage — verdict (#2019)', () => {
    let stage: BusinessLogicValidationStage;
    let agent: { execute: jest.Mock; validate: jest.Mock };

    const context = (): CodeReviewPipelineContext =>
        ({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { id: 'repo-1', name: 'tickets-web' },
            pullRequest: {
                number: 250,
                title: 'feat: assignee badge',
                body: 'Closes #183',
                head: { ref: 'feat/assignee-badge' },
                base: { ref: 'main' },
            },
            platformType: 'github',
            codeReviewConfig: { reviewOptions: { business_logic: true } },
            errors: [],
        }) as unknown as CodeReviewPipelineContext;

    /** The analyzer's report and its structured verdict, as the provider
     *  returns them. `execute` is the string-only door main still reads. */
    const agentReturns = (
        report: string,
        validationResult: ValidationResult,
    ) => {
        agent.execute.mockResolvedValue(report);
        agent.validate.mockResolvedValue({
            response: report,
            validationResult,
        });
    };

    const report = (statusLine: string, findings: string) =>
        [
            '## Business Rules Validation',
            '',
            '**Task:** #183 - Show an "assigned to you" badge',
            statusLine,
            '**Confidence:** high',
            '',
            '### Findings',
            findings,
        ].join('\n');

    beforeEach(async () => {
        agent = { execute: jest.fn(), validate: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BusinessLogicValidationStage,
                {
                    provide: BusinessRulesValidationAgentProvider,
                    useValue: agent,
                },
                { provide: MCPManagerService, useValue: {} },
            ],
        }).compile();

        stage = module.get(BusinessLogicValidationStage);
        jest.spyOn(
            stage as any,
            'getConnectedTaskManagementMcps',
        ).mockResolvedValue(['gitissues']);
        jest.spyOn(stage as any, 'hasRelevantBusinessSignals').mockReturnValue(
            true,
        );
    });

    it.each([
        [
            'English',
            '**Status:** Compliant',
            '#### INFO: All acceptance criteria are covered',
        ],
        [
            'Portuguese',
            '**Status:** Em conformidade',
            '#### INFO: Todos os critérios foram implementados',
        ],
        [
            'Spanish',
            '**Estado:** Cumple',
            '#### INFO: Todos los criterios están implementados',
        ],
    ])(
        'records a compliant verdict as a pass whatever the report language (%s)',
        async (_language, statusLine, findings) => {
            agentReturns(report(statusLine, findings), {
                needsMoreInfo: false,
                mode: 'full_analysis',
                reason: 'analysis_ready',
                confidence: 'high',
                status: 'compliant',
                findings: [
                    {
                        severity: 'info',
                        title: 'All acceptance criteria are covered',
                    },
                ],
                summary: report(statusLine, findings),
            });

            const result = await stage.execute(context());

            expect(result.businessLogicOutcome).toMatchObject({
                kind: 'success',
            });
            expect(result.businessLogicResults?.[0]?.severity).toBe(
                SeverityLevel.LOW,
            );
        },
    );

    it('records an issues_found verdict as a gap even when the prose says "no issues"', async () => {
        const text = report(
            '**Status:** Issues Found',
            '#### MUST_FIX: Badge shows for unassigned tickets\nThere are no issues with the comparison itself.',
        );
        agentReturns(text, {
            needsMoreInfo: false,
            reason: 'analysis_ready',
            confidence: 'high',
            status: 'issues_found',
            findings: [
                {
                    severity: 'must_fix',
                    title: 'Badge shows for unassigned tickets',
                },
            ],
            summary: text,
        });

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'gap_found',
        });
    });

    it('records a scope_mismatch verdict as a gap', async () => {
        const text = report(
            '**Status:** Issues Found',
            '#### MUST_FIX: PR scope does not match the task scope',
        );
        agentReturns(text, {
            needsMoreInfo: false,
            reason: 'analysis_ready',
            status: 'scope_mismatch',
            findings: [
                {
                    severity: 'must_fix',
                    title: 'PR scope does not match the task scope',
                },
            ],
            summary: text,
        });

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'gap_found',
        });
    });

    it('derives the verdict from the findings when the analyzer left status out', async () => {
        const text = report(
            '**Estado:** Cumple',
            '#### INFO: Todo implementado',
        );
        agentReturns(text, {
            needsMoreInfo: false,
            reason: 'analysis_ready',
            findings: [{ severity: 'info', title: 'Todo implementado' }],
            summary: text,
        });

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({ kind: 'success' });
    });

    it('counts a suggestion finding as a gap when the analyzer left status out', async () => {
        const text = report(
            '**Status:** Compliant',
            '#### SUGGESTION: Add an aria-label to the badge',
        );
        agentReturns(text, {
            needsMoreInfo: false,
            reason: 'analysis_ready',
            findings: [
                {
                    severity: 'suggestion',
                    title: 'Add an aria-label to the badge',
                },
            ],
            summary: text,
        });

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'gap_found',
        });
    });
});

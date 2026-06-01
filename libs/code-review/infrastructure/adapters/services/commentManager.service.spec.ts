import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    BehaviourForExistingDescription,
    SummaryConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

// Mock BYOKPromptRunnerService at module level so we can capture the
// SYSTEM prompt the LLM receives (Bug E) and short-circuit the LLM
// call to a deterministic summary (Bug A).
const capturedPrompts: Array<{ prompt: string; role: string }> = [];
const NEW_SUMMARY_TEXT = 'NEW_SUMMARY_CONTENT';

jest.mock(
    '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service',
    () => ({
        BYOKPromptRunnerService: jest
            .fn()
            .mockImplementation(() => ({
                executeMode: 'mock',
                builder: () => {
                    const chain: any = {
                        setParser: () => chain,
                        setLLMJsonMode: () => chain,
                        setPayload: () => chain,
                        addPrompt: (p: { prompt: string; role: string }) => {
                            capturedPrompts.push(p);
                            return chain;
                        },
                        addMetadata: () => chain,
                        addCallbacks: () => chain,
                        setRunName: () => chain,
                        setTemperature: () => chain,
                        execute: async () => NEW_SUMMARY_TEXT,
                    };
                    return chain;
                },
            })),
    }),
);

import { CommentManagerService } from './commentManager.service';

describe('CommentManagerService.generateSummaryPR', () => {
    let service: CommentManagerService;
    let codeManagementService: { getPullRequestByNumber: jest.Mock };
    let observabilityService: { runLLMInSpan: jest.Mock };
    let parametersService: any;
    let messageProcessor: any;
    let promptRunnerService: any;
    let permissionValidationService: any;

    const stubRepository = { name: 'sample', id: 'repo-id' };
    const stubOrg = { organizationId: 'org-1', teamId: 'team-1' };
    const stubPR = {
        number: 7,
        title: 'feat: example',
        head: { ref: 'feat/x', repo: { fullName: 'kodus/sample' } },
        base: { ref: 'main' },
    };
    const summaryConfig: SummaryConfig = {
        generatePRSummary: true,
        behaviourForExistingDescription:
            BehaviourForExistingDescription.CONCATENATE,
    } as any;

    beforeEach(() => {
        capturedPrompts.length = 0;

        codeManagementService = { getPullRequestByNumber: jest.fn() };

        observabilityService = {
            runLLMInSpan: jest.fn(async ({ exec }) => {
                // Run the exec callback so the mocked BYOKPromptRunnerService
                // (above) actually receives the prompts via addPrompt(...).
                const result = await exec(() => {});
                return { result };
            }),
        };

        parametersService = {};
        messageProcessor = {};
        promptRunnerService = {};
        permissionValidationService = {};

        service = new CommentManagerService(
            parametersService,
            messageProcessor,
            promptRunnerService,
            observabilityService as any,
            permissionValidationService,
            codeManagementService as any,
        );
    });

    describe('Bug A — re-run dedup of <!-- kody-pr-summary --> block (issue #1019)', () => {
        const startMarker = '<!-- kody-pr-summary:start -->';
        const endMarker = '<!-- kody-pr-summary:end -->';
        const countMarkers = (s: string) =>
            (s.match(new RegExp(startMarker, 'g')) ?? []).length;

        it('strips the previous block on re-run when CONCATENATE is set', async () => {
            // Simulate a re-run: the PR body already has a Kody summary
            // block (from the previous run), joined to the user's
            // original text by the `\n\n---\n\n` separator we emit.
            const userText = 'User-authored description text';
            const previousBlock = `${startMarker}\nOLD SUMMARY CONTENT\n${endMarker}`;
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body: `${userText}\n\n---\n\n${previousBlock}`,
            });

            const result = await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                /* isCommitRun */ false,
                /* prPreview */ false,
                /* externalPromptContext */ undefined,
                PlatformType.GITHUB,
            );

            // Exactly ONE summary block — the old one was stripped, the
            // freshly generated one was added in its place. Without the
            // fix, the old block survives and the new one is appended,
            // producing two start/end pairs.
            expect(countMarkers(result)).toBe(1);
            expect(result).toContain(NEW_SUMMARY_TEXT);
            // The user's original text outside the block is preserved.
            expect(result).toContain(userText);
            // The old summary content is gone.
            expect(result).not.toContain('OLD SUMMARY CONTENT');
        });

        it('does not stack blocks across multiple consecutive re-runs (anti-regression)', async () => {
            // Body that already accumulated TWO summary blocks (worst-case
            // legacy data from before the fix). The new code should still
            // collapse to a single block.
            const userText = 'Original text';
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body:
                    `${userText}\n\n---\n\n${startMarker}\nFirst run\n${endMarker}` +
                    `\n\n---\n\n${startMarker}\nSecond run\n${endMarker}`,
            });

            const result = await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                PlatformType.GITHUB,
            );

            expect(countMarkers(result)).toBe(1);
            expect(result).not.toContain('First run');
            expect(result).not.toContain('Second run');
            expect(result).toContain(NEW_SUMMARY_TEXT);
            expect(result).toContain(userText);
        });

        it('appends a fresh block to a clean body (first-ever run, no stripping needed)', async () => {
            const userText = 'I wrote this PR description';
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body: userText,
            });

            const result = await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                PlatformType.GITHUB,
            );

            expect(countMarkers(result)).toBe(1);
            expect(result).toContain(userText);
            expect(result).toContain(NEW_SUMMARY_TEXT);
        });

        it('handles a body with the marker but no separator (legacy data shape)', async () => {
            const userText = 'Old style body';
            // No `\n\n---\n\n` between user text and the block — older
            // version of Kody appended directly. The fix should still
            // strip the standalone block via the second regex.
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body: `${userText}${startMarker}\nlegacy\n${endMarker}`,
            });

            const result = await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                PlatformType.GITHUB,
            );

            expect(countMarkers(result)).toBe(1);
            expect(result).not.toContain('legacy');
            expect(result).toContain(userText);
        });
    });

    describe('Bug E — Length Constraint hint in the LLM prompt (Azure-only)', () => {
        beforeEach(() => {
            codeManagementService.getPullRequestByNumber.mockResolvedValue({
                body: 'irrelevant for prompt-shape tests',
            });
        });

        it('includes the Length Constraint block when platformType is AZURE_REPOS', async () => {
            await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                PlatformType.AZURE_REPOS,
            );

            const systemPrompt =
                capturedPrompts.find((p) => p.role === 'system')?.prompt ??
                capturedPrompts.map((p) => p.prompt).join('\n');

            expect(systemPrompt).toContain('Length Constraint (Azure DevOps)');
            // Target = 80% of 4000 → 3,200. The literal value is what
            // the prompt formatter emits via toLocaleString.
            expect(systemPrompt).toContain('3,200');
            // The hard limit appears too — same toLocaleString format.
            expect(systemPrompt).toContain('4,000');
        });

        it('omits the Length Constraint block when platformType is GITHUB', async () => {
            await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                PlatformType.GITHUB,
            );

            const systemPrompt =
                capturedPrompts.find((p) => p.role === 'system')?.prompt ??
                capturedPrompts.map((p) => p.prompt).join('\n');

            expect(systemPrompt).not.toContain('Length Constraint');
        });

        it('omits the Length Constraint block when platformType is undefined', async () => {
            await service.generateSummaryPR(
                stubPR,
                stubRepository,
                [{ filename: 'a.ts', patch: '+ x', status: 'modified' }],
                stubOrg,
                'en-US',
                summaryConfig,
                null,
                false,
                false,
                undefined,
                /* platformType */ undefined,
            );

            const systemPrompt =
                capturedPrompts.find((p) => p.role === 'system')?.prompt ??
                capturedPrompts.map((p) => p.prompt).join('\n');

            expect(systemPrompt).not.toContain('Length Constraint');
        });
    });
});

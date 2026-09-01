/**
 * commentAnalysis.service.spec.ts — structured-call delegation.
 *
 * Proves the comment-analysis consumer resolves the routed `codeReview` slot via
 * the permission service and then runs it through the SHARED structured executor
 * (`runStructuredReviewCall`) — instead of a hand-rolled resolveTaskModel +
 * wrapByokModel + tracedGenerateText copy. The executor owns the limiter,
 * reasoning, span, wire-schema conversion and retry (tested in its own spec), so
 * here we only assert the delegation boundary:
 *  - the org + `codeReview` task drive the slot resolution;
 *  - the CIPHERTEXT slot + trial default + telemetry metadata reach the executor;
 *  - decryption never happens here (the ciphertext slot is passed through as-is).
 *
 * Seam strategy: mock `resolveTaskSlot` (the permission-service method) and
 * `runStructuredReviewCall` (the shared executor) — no real model / network.
 */

const runStructuredReviewCall = jest.fn();
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: (...args: any[]) =>
        (runStructuredReviewCall as any)(...args),
}));

import { CommentAnalysisService } from './commentAnalysis.service';
import { KodyRuleSeverity } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('CommentAnalysisService — structured-call delegation', () => {
    let service: CommentAnalysisService;
    let observabilityService: { runAiSdkLLMInSpan: jest.Mock };
    let permissionValidationService: { resolveTaskSlot: jest.Mock };
    const resolveTaskSlot = jest.fn();

    const org = { organizationId: 'org-1', teamId: 'team-1' } as any;
    // A CIPHERTEXT-bearing slot (never plaintext) — the executor decrypts, not us.
    const CIPHERTEXT_SLOT = {
        provider: 'openai',
        apiKey: 'enc-oa',
        model: 'gpt-4o',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        resolveTaskSlot.mockResolvedValue(CIPHERTEXT_SLOT);
        // Irrelevance filter returns no ids → filterComments short-circuits to []
        // after exactly one structured call.
        runStructuredReviewCall.mockResolvedValue({ ids: [] });

        observabilityService = { runAiSdkLLMInSpan: jest.fn() };
        permissionValidationService = { resolveTaskSlot };

        service = new CommentAnalysisService(
            observabilityService as any,
            permissionValidationService as any,
        );
    });

    it('resolves the codeReview slot and delegates to the shared structured executor', async () => {
        await service.categorizeComments({
            comments: [{ id: 1, body: 'a comment' } as any],
            organizationAndTeamData: org,
        });

        expect(resolveTaskSlot).toHaveBeenCalledWith(org, 'codeReview');
        // observabilityService is NOT threaded by the service anymore — LLM.run
        // owns the span internally (app singleton), so it never appears here.
        expect(runStructuredReviewCall).toHaveBeenCalledWith(
            expect.objectContaining({
                byokConfig: CIPHERTEXT_SLOT,
                defaultModelOverride: undefined,
                spanName: expect.stringContaining(
                    `${CommentAnalysisService.name}::`,
                ),
                telemetryMetadata: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
            }),
        );
    });

    it('hands the executor the CIPHERTEXT slot — decryption stays inside the executor', async () => {
        await service.categorizeComments({
            comments: [{ id: 1, body: 'a comment' } as any],
            organizationAndTeamData: org,
        });

        const arg = runStructuredReviewCall.mock.calls[0][0];
        expect(arg.byokConfig).toEqual(CIPHERTEXT_SLOT);
        expect(arg.byokConfig.apiKey).toBe('enc-oa'); // ciphertext, not decrypted here
    });
});

/**
 * Pure comment-processing logic — the deterministic core that decides WHICH
 * comments the rule-learner ever sees. None of it touches the LLM, yet a
 * regression here silently changes the training set: a bot slips through, a
 * duplicate is learned twice, an excluded reviewer's comment is kept, a
 * short/Kody-authored comment pollutes the corpus, or the wrong language is
 * tagged. The delegation block above never exercises any of it. We build the
 * service with inert deps and drive the pure methods directly.
 */
describe('CommentAnalysisService — pure comment processing', () => {
    const build = () =>
        new CommentAnalysisService(
            { runAiSdkLLMInSpan: jest.fn() } as any,
            { resolveTaskSlot: jest.fn() } as any,
        );
    const svc = () => build() as any;
    const long = (seed: string) => seed.repeat(120); // comfortably > 100 chars

    describe('processComments', () => {
        const pr = (over: any = {}) => ({
            pr: { id: 'pr-1' },
            generalComments: [],
            reviewComments: [],
            ...over,
        });

        it('merges general+review, dedups by id, and drops comments of length <= 100', () => {
            const out = svc().processComments([
                pr({
                    generalComments: [{ id: 1, body: long('a') }],
                    reviewComments: [
                        { id: 1, body: 'duplicate id — dropped' },
                        { id: 2, body: 'x'.repeat(100) }, // exactly 100 → dropped (boundary)
                    ],
                }),
            ]);

            expect(out).toHaveLength(1);
            expect(out[0].id).toBe(1);
        });

        it('keeps a comment of length 101 (strictly greater than 100)', () => {
            const out = svc().processComments([
                pr({ generalComments: [{ id: 1, body: 'x'.repeat(101) }] }),
            ]);
            expect(out).toHaveLength(1);
        });

        it('builds an Azure composite id from threadId+id', () => {
            const out = svc().processComments([
                pr({
                    generalComments: [
                        { id: 5, threadId: 't9', body: long('a') },
                    ],
                }),
            ]);
            expect(out[0].id).toBe('t9-5');
        });

        it('expands GitLab discussion notes (comments with no body key)', () => {
            const out = svc().processComments([
                pr({
                    generalComments: [
                        {
                            notes: [
                                {
                                    id: 'n1',
                                    body: long('a'),
                                    author: { id: 'u1' },
                                },
                            ],
                        },
                    ],
                }),
            ]);
            expect(out).toHaveLength(1);
            expect(out[0].id).toBe('n1');
        });

        it('drops bot-authored comments, keeps human ones', () => {
            const out = svc().processComments([
                pr({
                    generalComments: [
                        { id: 1, user: { type: 'Bot' }, body: long('a') },
                        { id: 2, user: { type: 'User' }, body: long('b') },
                    ],
                }),
            ]);
            expect(out.map((c: any) => c.id)).toEqual([2]);
        });

        it('drops excluded reviewers but keeps comments whose author is unidentifiable', () => {
            const out = svc().processComments(
                [
                    pr({
                        generalComments: [
                            { id: 1, user: { id: 99 }, body: long('a') },
                            { id: 2, body: long('b') }, // no author → kept
                        ],
                    }),
                ],
                new Set(['99']),
            );
            expect(out.map((c: any) => c.id)).toEqual([2]);
        });

        it('tags comments with the dominant supported language from the PR files', () => {
            const out = svc().processComments([
                pr({
                    generalComments: [{ id: 1, body: long('a') }],
                    files: [{ filename: 'a.ts' }, { filename: 'b.ts' }],
                }),
            ]);
            expect(out[0].language).toBe('typescript');
        });

        it('returns [] when nothing survives processing', () => {
            const out = svc().processComments([
                pr({ generalComments: [{ id: 1, body: 'too short' }] }),
            ]);
            expect(out).toEqual([]);
        });
    });

    describe('getCommentAuthorId', () => {
        const id = (c: any) => svc().getCommentAuthorId(c);

        it('prefers user.id and stringifies it', () => {
            expect(id({ user: { id: 42 } })).toBe('42');
        });
        it('falls back to author.id (GitLab shape)', () => {
            expect(id({ author: { id: 'g1' } })).toBe('g1');
        });
        it('stringifies a zero id rather than treating it as absent', () => {
            expect(id({ user: { id: 0 } })).toBe('0');
        });
        it.each([[''], [null], [undefined]])(
            'returns undefined for an empty/nullish id (%p)',
            (raw) => {
                expect(id({ user: { id: raw } })).toBeUndefined();
            },
        );
    });

    describe('fileExtensionFrequencyAnalysis', () => {
        it('returns per-extension frequencies as fractions of the total', () => {
            const out = svc().fileExtensionFrequencyAnalysis([
                { filename: 'a.ts' },
                { filename: 'b.ts' },
                { filename: 'c.js' },
            ]);
            expect(out.ts).toBeCloseTo(2 / 3);
            expect(out.js).toBeCloseTo(1 / 3);
        });

        it('returns an empty map (no divide-by-zero) for no files', () => {
            expect(svc().fileExtensionFrequencyAnalysis([])).toEqual({});
        });
    });

    describe('mapRuleUuidToRule', () => {
        it('keeps only rules whose uuid is in the list', () => {
            const out = svc().mapRuleUuidToRule({
                rules: [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }],
                uuids: ['b', 'c'],
            });
            expect(out.map((r: any) => r.uuid)).toEqual(['b', 'c']);
        });
    });

    describe('standardizeRules', () => {
        it('blanks a non-library uuid and fills the canonical defaults', () => {
            const out = svc().standardizeRules({
                rules: [{ uuid: 'not-in-library', title: 'T', rule: 'R' }],
            });
            expect(out).toEqual([
                {
                    uuid: '',
                    title: 'T',
                    rule: 'R',
                    severity: KodyRuleSeverity.LOW,
                    examples: [],
                    repositoryId: 'global',
                    status: KodyRulesStatus.PENDING,
                },
            ]);
        });
    });
});

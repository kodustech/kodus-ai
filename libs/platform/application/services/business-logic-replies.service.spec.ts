import { DEFAULT_BUSINESS_LOGIC_SETTINGS } from '@libs/agents/business-validation/settings';

import { BusinessLogicReplies } from './business-logic-replies.service';

const run = {
    id: 'run-1',
    organizationId: 'org-1',
    repositoryId: 'repo-1',
    pullRequestNumber: 47,
    outcome: 'validated',
    headSha: 'abc1234',
    comment: { id: 501 },
    trackers: ['Linear'],
    unseenFiles: [],
    references: [],
    attempts: [],
    door: 'auto',
    createdAt: new Date(),
    tasks: [
        {
            tracker: 'Linear',
            id: 'SAA-96',
            readAt: '2026-10-05T12:00:00Z',
            passed: false,
            requirements: [
                {
                    requirement: 'Order persists after reload',
                    state: 'met',
                    evidence: [],
                    confidence: 'high',
                },
                {
                    requirement: 'Keyboard reordering',
                    state: 'missing',
                    evidence: [],
                    confidence: 'high',
                },
            ],
            outOfScope: [],
        },
    ],
};

const request = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'notes' },
    pullRequest: { number: 47 },
    platformType: 'github',
    diff: '',
};

function build(intent: any, revalidated?: any) {
    const service = {
        classifyReply: jest.fn(async () => intent),
        inTeamLanguage: jest.fn(async (_org: unknown, text: string) => text),
        tryRead: jest.fn(async () => ({ status: 'found' })),
        validate: jest.fn(async () => revalidated),
    };
    const publisher = {
        settingsFor: jest.fn(async () => DEFAULT_BUSINESS_LOGIC_SETTINGS),
        headShaOf: jest.fn(async () => 'def5678'),
        publish: jest.fn(async (input: any) => ({
            outcome: input.result.outcome,
            comment: 'updated',
        })),
    };
    const runs = { latestForPullRequest: jest.fn(async () => run) };
    return {
        replies: new BusinessLogicReplies(
            service as any,
            publisher as any,
            runs as any,
        ),
        service,
        publisher,
    };
}

describe('BusinessLogicReplies', () => {
    it('leaves a question to the chat', async () => {
        const { replies } = build({ intent: 'other' });
        await expect(
            replies.handle({
                request,
                message: 'why?',
                sender: { login: 'nina' },
                authorLogin: 'rafa',
            }),
        ).resolves.toEqual({ handled: false });
    });

    it('never lets the PR author waive their own requirement (UC-37)', async () => {
        const { replies, publisher } = build({
            intent: 'accept',
            findings: [1],
        });

        const result = await replies.handle({
            request,
            message: 'out of scope',
            sender: { login: 'rafa' },
            authorLogin: 'rafa',
        });

        expect(result).toMatchObject({
            handled: true,
            reply: expect.stringContaining('not the PR author'),
        });
        expect(publisher.publish).not.toHaveBeenCalled();
    });

    it("marks a reviewer's acceptance, checks the task it moved to exists, and turns the check green", async () => {
        const { replies, service, publisher } = build({
            intent: 'accept',
            findings: [1],
            movedTo: 'SAA-102',
        });

        const result = await replies.handle({
            request,
            message: 'Keyboard reordering is out of scope, split into SAA-102.',
            sender: { login: 'nina' },
            authorLogin: 'rafa',
        });

        expect(service.tryRead).toHaveBeenCalledWith(
            expect.anything(),
            'SAA-102',
            expect.anything(),
        );
        const published = publisher.publish.mock.calls[0][0];
        expect(published.trigger).toBe('accepted');
        const keyboard =
            published.result.outcome.checks[0].verdict.requirements[1];
        expect(keyboard.accepted).toMatchObject({
            by: 'nina',
            movedTo: 'SAA-102',
        });
        expect(published.result.outcome.passed).toBe(true);
        expect(result).toMatchObject({
            handled: true,
            reply: expect.stringContaining('check is now green'),
        });
    });

    it('re-checks a dispute with what the author pointed at and says whether it changed (UC-38)', async () => {
        const revalidated = {
            outcome: {
                kind: 'validated',
                checks: [
                    {
                        task: { tracker: 'Linear', id: 'SAA-96' },
                        verdict: {
                            needsMoreInfo: false,
                            summary: '',
                            requirements: [
                                {
                                    requirement: 'Keyboard reordering',
                                    state: 'missing',
                                    evidence: [],
                                    note: 'useDrag.ts handles pointer events only; no key handler.',
                                    confidence: 'high',
                                },
                            ],
                            outOfScope: [],
                        },
                        passed: false,
                        readAt: 'x',
                    },
                ],
                thinTasks: [],
                passed: false,
                unseenFiles: [],
            },
            references: [],
            attempts: [],
            trackers: ['Linear'],
        };
        const { replies, service } = build(
            {
                intent: 'dispute',
                findings: [1],
                files: ['useDrag.ts'],
                claim: 'covered in useDrag.ts',
            },
            revalidated,
        );

        const result = await replies.handle({
            request,
            message: "it's covered in useDrag.ts",
            sender: { login: 'rafa' },
            authorLogin: 'rafa',
        });

        expect(service.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                door: 'command',
                taskInput: 'SAA-96',
                authorClaim: {
                    claim: 'covered in useDrag.ts',
                    requirements: ['Keyboard reordering'],
                    files: ['useDrag.ts'],
                },
            }),
        );
        expect(
            revalidated.outcome.checks[0].verdict.requirements[0],
        ).toMatchObject({
            disputed: 'upheld',
        });
        expect(result).toMatchObject({
            handled: true,
            reply: expect.stringContaining('still MISSING'),
        });
    });
});

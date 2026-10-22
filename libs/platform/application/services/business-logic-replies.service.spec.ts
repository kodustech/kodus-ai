import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
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
            url: 'https://linear.app/acme/issue/SAA-96',
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
    platformType: PlatformType.GITHUB,
    diff: '',
};

function build(intent: any, revalidated?: any, latest: any = run) {
    const service = {
        classifyReply: jest.fn(async () => intent),
        inTeamLanguage: jest.fn(async (_org: unknown, text: string) => text),
        tryRead: jest.fn(async (_org: unknown, id: string) => ({
            status: id === 'SAA-102' ? 'found' : 'not_found',
        })),
        validate: jest.fn(async () => revalidated),
    };
    const publisher = {
        configFor: jest.fn(async () => ({
            settings: DEFAULT_BUSINESS_LOGIC_SETTINGS,
            enabled: true,
        })),
        withRepository: jest.fn((r: unknown) => r),
        headShaOf: jest.fn(async () => 'def5678'),
        publish: jest.fn(async (input: any) => ({
            outcome: input.result.outcome,
            comment: 'updated',
        })),
    };
    const runs = { latestForPullRequest: jest.fn(async () => latest) };
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
                message: 'Keyboard reordering: why?',
                sender: { login: 'nina' },
            }),
        ).resolves.toEqual({ handled: false });
    });

    it('never asks the classifier about a comment that does not answer the Business Logic comment', async () => {
        const { replies, service } = build({
            intent: 'dispute',
            findings: [1],
        });
        await expect(
            replies.handle({
                request,
                message: '@kody can you explain the caching in this PR?',
                sender: { login: 'nina' },
            }),
        ).resolves.toEqual({ handled: false });
        expect(service.classifyReply).not.toHaveBeenCalled();
    });

    it("reads a reply in the comment's own thread, a quote of it or the task's id as an answer", async () => {
        for (const reply of [
            { message: 'out of scope', threadId: '501' },
            {
                message:
                    '> **Business Logic**: 1 missing\n\nout of scope for now',
            },
            { message: 'SAA-96 is out of scope here' },
        ]) {
            const { replies, service } = build({ intent: 'other' });
            await replies.handle({
                request,
                sender: { login: 'nina' },
                ...reply,
            });
            expect(service.classifyReply).toHaveBeenCalled();
        }
    });

    it('leaves a question that only uses a state word, or a longer id, to the chat', async () => {
        for (const message of [
            'why is the null check missing in foo.ts?',
            'SAA-961 is a different task',
        ]) {
            const { replies, service } = build({ intent: 'other' });
            await replies.handle({
                request,
                sender: { login: 'nina' },
                message,
            });
            expect(service.classifyReply).not.toHaveBeenCalled();
        }
    });

    it('asks who the sender is only when a reply accepts', async () => {
        const access = jest.fn(async () => ({ canWrite: false }));
        const { replies, publisher } = build({
            intent: 'accept',
            findings: [1],
        });
        const result = await replies.handle({
            request,
            message: 'Keyboard reordering is out of scope',
            sender: { login: 'rafa', access },
        });
        expect(access).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ handled: true });
        expect(publisher.publish).not.toHaveBeenCalled();

        const quiet = jest.fn();
        const other = build({ intent: 'other' });
        await other.replies.handle({
            request,
            message: 'what does this PR do?',
            sender: { login: 'rafa', access: quiet },
        });
        expect(quiet).not.toHaveBeenCalled();
    });

    it('accepts nothing when the access lookup fails', async () => {
        const { replies, publisher } = build({
            intent: 'accept',
            findings: [1],
        });
        const result = await replies.handle({
            request,
            message: 'Keyboard reordering is out of scope',
            sender: {
                login: 'rafa',
                access: async () => {
                    throw new Error('502');
                },
            },
        });
        expect(result).toMatchObject({
            handled: true,
            reply: expect.stringContaining('nothing was accepted'),
        });
        expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('records who accepted (UC-37)', async () => {
        const { replies, publisher } = build({
            intent: 'accept',
            findings: [1],
        });

        const result = await replies.handle({
            request,
            message: 'Keyboard reordering is out of scope',
            sender: { login: 'rafa' },
        });

        expect(result).toMatchObject({
            handled: true,
            reply: expect.stringContaining('accepted by @rafa'),
        });
        expect(publisher.publish).toHaveBeenCalled();
    });

    it("never lets the PR's author accept its own requirements", async () => {
        const { replies, publisher } = build({
            intent: 'accept',
            findings: [1],
        });

        const result = await replies.handle({
            request,
            message: 'Keyboard reordering is out of scope',
            sender: { login: 'rafa', canWrite: true, isAuthor: true },
        });

        expect(result).toMatchObject({
            handled: true,
            reply: expect.stringContaining('ask a reviewer'),
        });
        expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('refuses someone without write access to the repository', async () => {
        const { replies, publisher } = build({
            intent: 'accept',
            findings: [1],
        });

        const result = await replies.handle({
            request,
            message: 'Keyboard reordering is out of scope',
            sender: { login: 'drive-by', canWrite: false },
        });

        expect(result).toMatchObject({
            reply: expect.stringContaining('write access'),
        });
        expect(publisher.publish).not.toHaveBeenCalled();
    });

    it.each([PlatformType.GITHUB, PlatformType.GITLAB])(
        'never talks about a check, on any platform (%s)',
        async (platformType) => {
            const { replies } = build({ intent: 'accept', findings: [1] });

            const result = await replies.handle({
                request: { ...request, platformType },
                message: 'Keyboard reordering is out of scope',
                sender: { login: 'Nina' },
            });

            expect(result.handled && result.reply).not.toMatch(
                /kody\/business-logic|check/,
            );
        },
    );

    it("marks a reviewer's acceptance, checks the task it moved to exists, and says nothing is left to merge", async () => {
        const { replies, service, publisher } = build({
            intent: 'accept',
            findings: [1],
            movedTo: 'SAA-102',
        });

        const result = await replies.handle({
            request,
            message: 'Keyboard reordering is out of scope, split into SAA-102.',
            sender: { login: 'nina' },
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
            reply: expect.stringContaining('Nothing is left to merge'),
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
            message: 'Keyboard reordering is covered in useDrag.ts',
            sender: { login: 'rafa' },
        });

        expect(service.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                door: 'command',
                taskInput: 'https://linear.app/acme/issue/SAA-96',
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

    it('re-checks a dispute with the id when the task link is not one the parser reads back', async () => {
        const { replies, service } = build(
            {
                intent: 'dispute',
                findings: [1],
                files: [],
                claim: 'covered',
            },
            { outcome: { kind: 'skipped', reason: 'x', message: 'x' } },
            {
                ...run,
                tasks: [
                    {
                        ...run.tasks[0],
                        tracker: 'Tickets',
                        id: 'OPS-12',
                        url: 'https://app.asana.com/0/1201/1207',
                    },
                ],
            },
        );

        await replies.handle({
            request,
            message: 'OPS-12 is covered',
            sender: { login: 'rafa' },
        });

        expect(service.validate).toHaveBeenCalledWith(
            expect.objectContaining({ taskInput: 'OPS-12' }),
        );
    });

    it('accepts nothing when the task it moved to does not exist', async () => {
        const { replies, publisher } = build({
            intent: 'accept',
            findings: [1],
            movedTo: 'SAA-999',
        });

        const result = await replies.handle({
            request,
            message: 'Keyboard reordering moved to SAA-999',
            sender: { login: 'nina' },
        });

        expect(publisher.publish).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            handled: true,
            reply: expect.stringContaining("couldn't find SAA-999"),
        });
    });

    it('refuses an acceptance from someone without write access (GitHub)', async () => {
        const { replies, publisher } = build({
            intent: 'accept',
            findings: [1],
        });

        const result = await replies.handle({
            request,
            message: 'Keyboard reordering is out of scope',
            sender: { login: 'drive-by', canWrite: false },
        });

        expect(publisher.publish).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            handled: true,
            reply: expect.stringContaining('write access'),
        });
    });
});

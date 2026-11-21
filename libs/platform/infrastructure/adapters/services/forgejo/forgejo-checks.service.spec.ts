import {
    CheckConclusion,
    CheckStatus,
    UnknownCheckConclusionError,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { repoCreateStatus } from '@llamaduck/forgejo-ts';

import { KODY_CHECK_RUN_NAME } from '@libs/core/infrastructure/pipeline/services/pipeline-checks.service';

import { ForgejoChecksService } from './forgejo-checks.service';

jest.mock('@llamaduck/forgejo-ts', () => ({ repoCreateStatus: jest.fn() }));
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('ForgejoChecksService', () => {
    const forgejoService = {
        getAuthDetails: jest
            .fn()
            .mockResolvedValue({ host: 'https://forgejo.example' }),
        createForgejoClient: jest.fn().mockReturnValue({}),
    };
    const service = new ForgejoChecksService(forgejoService as any);
    const base = {
        organizationAndTeamData: { organizationId: 'org-1' },
        repository: { owner: 'acme', name: 'widgets' },
        checkRunId: `sha:${'a'.repeat(40)}`,
    };
    const createStatus = repoCreateStatus as jest.Mock;

    beforeEach(() => createStatus.mockReset().mockResolvedValue({}));

    it.each([
        [CheckConclusion.SUCCESS, 'success'],
        [CheckConclusion.FAILURE, 'failure'],
        [CheckConclusion.ACTION_REQUIRED, 'failure'],
        [CheckConclusion.CANCELLED, 'error'],
        [CheckConclusion.TIMED_OUT, 'error'],
        [CheckConclusion.NEUTRAL, 'warning'],
    ])('posts %s as the commit state %s', async (conclusion, state) => {
        await expect(
            service.updateCheckRun({
                ...base,
                status: CheckStatus.COMPLETED,
                conclusion,
            }),
        ).resolves.toBe(true);
        expect(createStatus.mock.calls[0][0].body.state).toBe(state);
    });

    it('posts QUEUED as pending', async () => {
        await service.createCheckRun({
            ...base,
            headSha: 'a'.repeat(40),
            status: CheckStatus.QUEUED,
            name: 'Kody',
            output: { title: 'Queued', summary: '' },
        });
        expect(createStatus.mock.calls[0][0].body.state).toBe('pending');
    });

    it('throws on a completed status without a conclusion instead of posting success', async () => {
        await expect(
            service.updateCheckRun({ ...base, status: CheckStatus.COMPLETED }),
        ).rejects.toBeInstanceOf(UnknownCheckConclusionError);
        expect(createStatus).not.toHaveBeenCalled();
    });

    it('throws on an unknown conclusion', async () => {
        await expect(
            service.updateCheckRun({
                ...base,
                status: CheckStatus.COMPLETED,
                conclusion: 'stale' as CheckConclusion,
            }),
        ).rejects.toBeInstanceOf(UnknownCheckConclusionError);
        expect(createStatus).not.toHaveBeenCalled();
    });

    describe('one commit status context per check name', () => {
        const sha = 'b'.repeat(40);
        const contextOf = (call: number) =>
            createStatus.mock.calls[call][0].body.context;

        const open = (name: string) =>
            service.createCheckRun({
                ...base,
                headSha: sha,
                status: CheckStatus.IN_PROGRESS,
                name,
                output: { title: 'Running', summary: '' },
            });

        it('keeps the code review on its existing context', async () => {
            const id = await open(KODY_CHECK_RUN_NAME);
            await service.updateCheckRun({
                ...base,
                checkRunId: id!,
                status: CheckStatus.COMPLETED,
                conclusion: CheckConclusion.SUCCESS,
            });

            expect(contextOf(0)).toBe('Kodus Code Review');
            expect(contextOf(1)).toBe('Kodus Code Review');
        });

        it('posts another check, opened and closed, under its own name and never the code review context', async () => {
            const id = await open('Kody Runtime');
            await service.updateCheckRun({
                ...base,
                checkRunId: id!,
                status: CheckStatus.COMPLETED,
                conclusion: CheckConclusion.FAILURE,
                output: { title: 'Regression found', summary: '' },
            });

            expect(contextOf(0)).toBe('Kody Runtime');
            expect(contextOf(1)).toBe('Kody Runtime');
            expect(createStatus.mock.calls[1][0].body.description).toBe(
                'Regression found',
            );
        });

        it('keeps two checks on the same commit apart', async () => {
            const review = await open(KODY_CHECK_RUN_NAME);
            const runtime = await open('Kody Runtime (staging)');
            expect(review).not.toEqual(runtime);

            await service.updateCheckRun({
                ...base,
                checkRunId: runtime!,
                status: CheckStatus.COMPLETED,
                conclusion: CheckConclusion.FAILURE,
            });
            await service.updateCheckRun({
                ...base,
                checkRunId: review!,
                status: CheckStatus.COMPLETED,
                conclusion: CheckConclusion.SUCCESS,
            });

            expect(contextOf(2)).toBe('Kody Runtime (staging)');
            expect(contextOf(3)).toBe('Kodus Code Review');
        });

        it('updates an id stored before contexts were encoded under the code review context', async () => {
            await service.updateCheckRun({
                ...base,
                checkRunId: `sha:${sha}`,
                status: CheckStatus.COMPLETED,
                conclusion: CheckConclusion.FAILURE,
            });
            expect(contextOf(0)).toBe('Kodus Code Review');
            expect(createStatus.mock.calls[0][0].path.sha).toBe(sha);
        });
    });
});

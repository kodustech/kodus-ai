import { ClassifyOrphanedSessionsCronProvider } from '../classifyOrphanedSessions.cron';
import { SessionEventRepository } from '@libs/cli-review/infrastructure/repositories/session-event.repository';
import { ClassifySessionUseCase } from '@libs/cli-review/application/use-cases/classify-session.use-case';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }),
}));

function makeOrphanedSession(sessionId: string) {
    return {
        sessionId,
        organizationId: 'org-1',
        teamId: 'team-1',
        branch: 'main',
        lastEventTimestamp: new Date('2025-01-01T00:00:00Z'),
    };
}

describe('ClassifyOrphanedSessionsCronProvider', () => {
    let cron: ClassifyOrphanedSessionsCronProvider;
    let repo: jest.Mocked<SessionEventRepository>;
    let classifyUseCase: jest.Mocked<ClassifySessionUseCase>;

    beforeEach(() => {
        repo = {
            findOrphanedSessions: jest.fn().mockResolvedValue([]),
            findUnclassifiedSyntheticEnds: jest.fn().mockResolvedValue([]),
            create: jest.fn(),
        } as any;

        classifyUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        } as any;

        cron = new ClassifyOrphanedSessionsCronProvider(repo, classifyUseCase);
    });

    it('does nothing when no orphaned sessions found', async () => {
        await cron.handleCron();

        expect(repo.findOrphanedSessions).toHaveBeenCalledWith(30, 10);
        expect(repo.create).not.toHaveBeenCalled();
        expect(classifyUseCase.execute).not.toHaveBeenCalled();
    });

    it('creates synthetic session_end and triggers classification', async () => {
        const orphaned = makeOrphanedSession('sess-orphan-1');
        repo.findOrphanedSessions.mockResolvedValue([orphaned]);
        repo.create.mockResolvedValue({ uuid: 'synth-end-1' } as any);

        await cron.handleCron();

        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-1',
                teamId: 'team-1',
                sessionId: 'sess-orphan-1',
                type: 'session_end',
                branch: 'main',
                payload: expect.objectContaining({
                    synthetic: true,
                    reason: 'orphaned_session_timeout',
                }),
            }),
        );

        expect(classifyUseCase.execute).toHaveBeenCalledWith('synth-end-1');
    });

    it('processes multiple orphaned sessions in chunks', async () => {
        const sessions = [
            makeOrphanedSession('sess-1'),
            makeOrphanedSession('sess-2'),
            makeOrphanedSession('sess-3'),
            makeOrphanedSession('sess-4'),
        ];
        repo.findOrphanedSessions.mockResolvedValue(sessions);
        repo.create.mockImplementation(async (data: any) => ({
            uuid: `synth-${data.sessionId}`,
        }));

        await cron.handleCron();

        expect(repo.create).toHaveBeenCalledTimes(4);
        expect(classifyUseCase.execute).toHaveBeenCalledTimes(4);
    });

    it('continues processing when one session fails', async () => {
        const sessions = [
            makeOrphanedSession('sess-ok'),
            makeOrphanedSession('sess-fail'),
        ];
        repo.findOrphanedSessions.mockResolvedValue(sessions);

        let callCount = 0;
        repo.create.mockImplementation(async (data: any) => {
            callCount++;
            if (data.sessionId === 'sess-fail') {
                throw new Error('DB error');
            }
            return { uuid: `synth-${data.sessionId}` } as any;
        });

        // Should not throw
        await cron.handleCron();

        // The successful one should still be classified
        // (both are in the same chunk with CONCURRENCY=3, so Promise.allSettled handles it)
        expect(repo.create).toHaveBeenCalledTimes(2);
    });

    it('does not throw when findOrphanedSessions fails', async () => {
        repo.findOrphanedSessions.mockRejectedValue(new Error('DB down'));

        // Should not throw
        await expect(cron.handleCron()).resolves.not.toThrow();
    });

    it('recovers unclassified synthetic session_end events from previous crashes', async () => {
        const stuckEvent = {
            uuid: 'stuck-end-1',
            sessionId: 'sess-stuck',
            type: 'session_end',
            payload: { synthetic: true },
        };
        repo.findUnclassifiedSyntheticEnds.mockResolvedValue([stuckEvent]);

        await cron.handleCron();

        expect(repo.findUnclassifiedSyntheticEnds).toHaveBeenCalledWith(10);
        expect(classifyUseCase.execute).toHaveBeenCalledWith('stuck-end-1');
    });

    it('handles both recovery and new orphans in the same run', async () => {
        const stuckEvent = { uuid: 'stuck-1', sessionId: 'sess-stuck' };
        repo.findUnclassifiedSyntheticEnds.mockResolvedValue([stuckEvent]);

        const orphaned = makeOrphanedSession('sess-new');
        repo.findOrphanedSessions.mockResolvedValue([orphaned]);
        repo.create.mockResolvedValue({ uuid: 'synth-new' } as any);

        await cron.handleCron();

        // Recovery + new orphan classification
        expect(classifyUseCase.execute).toHaveBeenCalledWith('stuck-1');
        expect(classifyUseCase.execute).toHaveBeenCalledWith('synth-new');
        expect(classifyUseCase.execute).toHaveBeenCalledTimes(2);
    });
});

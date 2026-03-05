import { SubmitCliSessionCaptureUseCase } from '@libs/cli-review/application/use-cases/submit-cli-session-capture.use-case';
import { ClassifyCliSessionCaptureUseCase } from '@libs/cli-review/application/use-cases/classify-cli-session-capture.use-case';
import { CliSessionCaptureRepository } from '@libs/cli-review/infrastructure/repositories/cli-session-capture.repository';

const organizationAndTeamData = {
    organizationId: 'org_123',
    teamId: 'team_456',
};

const captureInput = {
    branch: 'feat/auth',
    sha: 'a1b2c3d4',
    orgRepo: 'kodustech/cli',
    agent: 'codex' as const,
    event: 'stop' as const,
    signals: {
        sessionId: 'sess_123',
        turnId: 'turn_456',
        prompt: 'Refactor auth to use JWT middleware',
        assistantMessage:
            'I decided to centralize token validation in middleware.',
        modifiedFiles: ['src/auth/middleware.ts', 'src/auth/jwt.ts'],
        toolUses: [
            {
                tool: 'Edit',
                filePath: 'src/auth/middleware.ts',
                summary: 'Added validation',
            },
        ],
    },
    summary: 'Auth refactor',
    capturedAt: '2025-06-01T10:30:00.000Z',
};

describe('SubmitCliSessionCaptureUseCase', () => {
    let useCase: SubmitCliSessionCaptureUseCase;
    let mockRepository: {
        create: jest.Mock;
        findByDedupKey: jest.Mock;
    };
    let mockClassifyUseCase: {
        execute: jest.Mock;
    };

    beforeEach(() => {
        mockRepository = {
            create: jest.fn(),
            findByDedupKey: jest.fn(),
        };

        mockClassifyUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };

        useCase = new SubmitCliSessionCaptureUseCase(
            mockRepository as unknown as CliSessionCaptureRepository,
            mockClassifyUseCase as unknown as ClassifyCliSessionCaptureUseCase,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('persists capture and schedules async classification', async () => {
        const setImmediateSpy = jest
            .spyOn(global, 'setImmediate')
            .mockImplementation((callback: (...args: unknown[]) => void) => {
                callback();
                return {} as NodeJS.Immediate;
            });

        mockRepository.create.mockResolvedValue({ captureId: 'cap_db' });

        const result = await useCase.execute({
            organizationAndTeamData,
            input: captureInput,
        });

        expect(result.accepted).toBe(true);
        expect(result.id).toMatch(/^cap_[a-z0-9]{18}$/);
        expect(mockRepository.create).toHaveBeenCalledTimes(1);

        const persisted = mockRepository.create.mock.calls[0][0];
        expect(persisted.captureId).toBe(result.id);
        expect(persisted.organizationId).toBe(
            organizationAndTeamData.organizationId,
        );
        expect(persisted.teamId).toBe(organizationAndTeamData.teamId);
        expect(persisted.branch).toBe(captureInput.branch);
        expect(persisted.signals).toEqual(captureInput.signals);
        expect(persisted.rawPayload).toEqual(captureInput);
        expect(persisted.capturedAt.toISOString()).toBe(
            captureInput.capturedAt,
        );
        expect(persisted.dedupKey).toMatch(/^[a-f0-9]{64}$/);

        expect(mockClassifyUseCase.execute).toHaveBeenCalledWith(result.id);
        setImmediateSpy.mockRestore();
    });

    it('returns accepted=false for duplicate key and uses existing capture id', async () => {
        mockRepository.create.mockRejectedValue({ code: 11000 });
        mockRepository.findByDedupKey.mockResolvedValue({
            captureId: 'cap_existing',
        });

        const result = await useCase.execute({
            organizationAndTeamData,
            input: captureInput,
        });

        expect(result).toEqual({
            id: 'cap_existing',
            accepted: false,
        });
        expect(mockRepository.findByDedupKey).toHaveBeenCalledTimes(1);
        expect(mockClassifyUseCase.execute).not.toHaveBeenCalled();
    });

    it('throws when duplicate key occurs and existing capture cannot be resolved', async () => {
        mockRepository.create.mockRejectedValue({ code: 11000 });
        mockRepository.findByDedupKey.mockResolvedValue(null);

        await expect(
            useCase.execute({
                organizationAndTeamData,
                input: captureInput,
            }),
        ).rejects.toThrow(
            'Duplicate CLI session capture detected but existing capture could not be resolved',
        );

        expect(mockRepository.findByDedupKey).toHaveBeenCalledTimes(1);
        expect(mockClassifyUseCase.execute).not.toHaveBeenCalled();
    });

    it('rethrows non-duplicate persistence errors', async () => {
        mockRepository.create.mockRejectedValue(new Error('mongo down'));

        await expect(
            useCase.execute({
                organizationAndTeamData,
                input: captureInput,
            }),
        ).rejects.toThrow('mongo down');

        expect(mockRepository.findByDedupKey).not.toHaveBeenCalled();
        expect(mockClassifyUseCase.execute).not.toHaveBeenCalled();
    });
});

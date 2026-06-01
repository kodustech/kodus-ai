import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

import {
    RuleFileReferenceCheckSource,
    ValidateRuleFileReferencesUseCase,
} from './validate-rule-file-references.use-case';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

const ORG = 'org-uuid-1';
const TEAM = 'team-uuid-1';
const REPO = { id: 'repo-1', name: 'acme/api' };

type AnyRule = {
    uuid: string;
    title: string;
    repositoryId: string;
    contextReferenceId?: string;
    createdByUserId?: string;
};

type FakeContextRef = {
    requirements?: Array<{
        dependencies?: Array<{
            type: string;
            metadata?: { filePath?: string };
        }>;
        metadata?: { syncErrors?: unknown[] };
    }>;
    processingStatus?: string | null;
    lastProcessedAt?: Date;
};

describe('ValidateRuleFileReferencesUseCase', () => {
    let kodyRulesService: any;
    let contextReferenceService: any;
    let codeManagementService: any;
    let notificationService: any;
    let useCase: ValidateRuleFileReferencesUseCase;

    const makeContextRef = (filePaths: string[]): FakeContextRef => ({
        processingStatus: 'completed',
        requirements: [
            {
                dependencies: filePaths.map((filePath) => ({
                    type: 'knowledge',
                    metadata: { filePath },
                })),
            },
        ],
    });

    beforeEach(() => {
        kodyRulesService = {
            findByOrganizationId: jest.fn(),
        };
        contextReferenceService = {
            findById: jest.fn(),
        };
        codeManagementService = {
            getRepositoryAllFiles: jest.fn().mockResolvedValue([]),
        };
        notificationService = {
            emit: jest.fn().mockResolvedValue(undefined),
        };
        useCase = new ValidateRuleFileReferencesUseCase(
            kodyRulesService,
            contextReferenceService,
            codeManagementService,
            notificationService,
        );
    });

    const exec = (source: RuleFileReferenceCheckSource, opts?: { syncInitiatorUserId?: string }) =>
        useCase.execute({
            organizationAndTeamData: { organizationId: ORG, teamId: TEAM },
            repository: REPO,
            source,
            syncInitiatorUserId: opts?.syncInitiatorUserId,
        });

    it('no-ops when there are no rules with externalReferences for the repo', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            rules: [
                {
                    uuid: 'r-1',
                    title: 'unrelated',
                    repositoryId: 'other-repo',
                    contextReferenceId: 'ctx-1',
                },
            ] as AnyRule[],
        });

        const result = await exec('manual');

        expect(result.invalidCount).toBe(0);
        expect(result.issues).toEqual([]);
        expect(contextReferenceService.findById).not.toHaveBeenCalled();
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('marks file paths missing from the repo and emits with full issue list', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            rules: [
                {
                    uuid: 'r-1',
                    title: 'No console.log',
                    repositoryId: REPO.id,
                    contextReferenceId: 'ctx-1',
                },
                {
                    uuid: 'r-2',
                    title: 'No fetch',
                    repositoryId: REPO.id,
                    contextReferenceId: 'ctx-2',
                },
            ] as AnyRule[],
        });
        contextReferenceService.findById.mockImplementation((id: string) =>
            Promise.resolve(
                id === 'ctx-1'
                    ? makeContextRef(['src/logger.ts'])
                    : makeContextRef(['src/http.ts', 'src/missing.ts']),
            ),
        );
        codeManagementService.getRepositoryAllFiles.mockResolvedValueOnce([
            { path: 'src/http.ts', size: 1 },
            // src/logger.ts and src/missing.ts are NOT in the repo.
        ]);

        const result = await exec('manual');

        expect(result.invalidCount).toBe(2);
        expect(result.issues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ruleId: 'r-1',
                    ruleName: 'No console.log',
                    filePath: 'src/logger.ts',
                }),
                expect.objectContaining({
                    ruleId: 'r-2',
                    ruleName: 'No fetch',
                    filePath: 'src/missing.ts',
                }),
            ]),
        );
        expect(notificationService.emit).toHaveBeenCalledTimes(1);
        const emitArg = notificationService.emit.mock.calls[0][0];
        expect(emitArg.event).toBe(NotificationEvent.RULE_FILE_REFERENCES_INVALID);
        expect(emitArg.organizationId).toBe(ORG);
        expect(emitArg.payload).toEqual(
            expect.objectContaining({
                source: 'manual',
                repoName: REPO.name,
                invalidCount: 2,
            }),
        );
    });

    it('does not emit when every referenced file still exists', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            rules: [
                {
                    uuid: 'r-1',
                    title: 'No console.log',
                    repositoryId: REPO.id,
                    contextReferenceId: 'ctx-1',
                },
            ] as AnyRule[],
        });
        contextReferenceService.findById.mockResolvedValueOnce(
            makeContextRef(['src/logger.ts']),
        );
        codeManagementService.getRepositoryAllFiles.mockResolvedValueOnce([
            { path: 'src/logger.ts', size: 1 },
        ]);

        const result = await exec('manual');

        expect(result.invalidCount).toBe(0);
        expect(notificationService.emit).not.toHaveBeenCalled();
    });

    it('IDE source: routes recipient to the sync initiator', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            rules: [
                {
                    uuid: 'r-1',
                    title: 'No console.log',
                    repositoryId: REPO.id,
                    contextReferenceId: 'ctx-1',
                },
            ] as AnyRule[],
        });
        contextReferenceService.findById.mockResolvedValueOnce(
            makeContextRef(['src/missing.ts']),
        );
        codeManagementService.getRepositoryAllFiles.mockResolvedValueOnce([]);

        await exec('ide', { syncInitiatorUserId: 'user-7' });

        const emitArg = notificationService.emit.mock.calls[0][0];
        expect(emitArg.recipients).toEqual([
            { kind: 'user', userId: 'user-7' },
        ]);
    });

    it('IDE source without initiator: falls back to role:OWNER', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            rules: [
                {
                    uuid: 'r-1',
                    title: 'No console.log',
                    repositoryId: REPO.id,
                    contextReferenceId: 'ctx-1',
                },
            ] as AnyRule[],
        });
        contextReferenceService.findById.mockResolvedValueOnce(
            makeContextRef(['src/missing.ts']),
        );
        codeManagementService.getRepositoryAllFiles.mockResolvedValueOnce([]);

        await exec('ide');

        const emitArg = notificationService.emit.mock.calls[0][0];
        expect(emitArg.recipients).toEqual([{ kind: 'role', role: Role.OWNER }]);
    });

    it('manual source: routes to rule owners (deduped) when createdByUserId present', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            rules: [
                {
                    uuid: 'r-1',
                    title: 'A',
                    repositoryId: REPO.id,
                    contextReferenceId: 'ctx-1',
                    createdByUserId: 'user-1',
                },
                {
                    uuid: 'r-2',
                    title: 'B',
                    repositoryId: REPO.id,
                    contextReferenceId: 'ctx-2',
                    // Same owner — should be deduped.
                    createdByUserId: 'user-1',
                },
                {
                    uuid: 'r-3',
                    title: 'C',
                    repositoryId: REPO.id,
                    contextReferenceId: 'ctx-3',
                    createdByUserId: 'user-2',
                },
            ] as AnyRule[],
        });
        contextReferenceService.findById.mockImplementation(() =>
            Promise.resolve(makeContextRef(['nope.ts'])),
        );
        codeManagementService.getRepositoryAllFiles.mockResolvedValueOnce([]);

        await exec('manual');

        const emitArg = notificationService.emit.mock.calls[0][0];
        expect(emitArg.recipients).toEqual(
            expect.arrayContaining([
                { kind: 'user', userId: 'user-1' },
                { kind: 'user', userId: 'user-2' },
            ]),
        );
        // Deduped to 2 unique owners, not 3.
        expect(emitArg.recipients.length).toBe(2);
    });

    it('manual source: falls back to role:OWNER when no rules have createdByUserId', async () => {
        kodyRulesService.findByOrganizationId.mockResolvedValueOnce({
            rules: [
                {
                    uuid: 'r-1',
                    title: 'A',
                    repositoryId: REPO.id,
                    contextReferenceId: 'ctx-1',
                },
            ] as AnyRule[],
        });
        contextReferenceService.findById.mockResolvedValueOnce(
            makeContextRef(['nope.ts']),
        );
        codeManagementService.getRepositoryAllFiles.mockResolvedValueOnce([]);

        await exec('manual');

        const emitArg = notificationService.emit.mock.calls[0][0];
        expect(emitArg.recipients).toEqual([{ kind: 'role', role: Role.OWNER }]);
    });

    it('never throws — failures in any dependency are logged and suppressed', async () => {
        kodyRulesService.findByOrganizationId.mockRejectedValueOnce(
            new Error('db down'),
        );

        await expect(exec('manual')).resolves.toEqual(
            expect.objectContaining({ invalidCount: 0, issues: [] }),
        );
        expect(notificationService.emit).not.toHaveBeenCalled();
    });
});

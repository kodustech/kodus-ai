import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import {
    IKodyRule,
    KodyRulesScope,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * Guards the core data-safety promise of every update/sync path: a partial
 * change must MERGE onto the stored rule, never replace it. `createOrUpdate`
 * (and the sync flows that call it) builds `{ ...existingRule, ...patch }`
 * before handing the rule to the repository, so any field the caller omits is
 * carried over from disk. These tests pin that merge at the service boundary —
 * i.e. they assert exactly what the service hands to `repository.updateRule` —
 * which, combined with the repository's field-level `$set` spec (per-field
 * write, undefined skipped), proves the full chain loses nothing.
 *
 * Why it matters: the previous repository write replaced the whole matched
 * array element (`rules.$`), so a partial patch — or a DTO carrying `undefined`
 * fields — silently wiped everything it didn't restate. Status toggles, IDE
 * syncs and reference updates all go through here.
 */
describe('KodyRulesService update/sync field preservation', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    // A fully-populated stored rule — every one of these fields must survive a
    // partial update that doesn't mention it.
    const existingRule: IKodyRule = {
        uuid: 'rule-1',
        type: KodyRulesType.STANDARD,
        title: 'Original title',
        rule: 'original body text',
        path: '**/*.ts',
        severity: 'high',
        status: KodyRulesStatus.ACTIVE,
        sourcePath: '.cursorrules',
        pinnedSync: true,
        repositoryId: 'repo-1',
        directoryId: 'dir-1',
        examples: [{ snippet: 'const x = 1;', isCorrect: true }] as any,
        origin: 'user' as any,
        scope: KodyRulesScope.FILE,
        contextReferenceId: 'ctx-ref-1',
        centralizedConfig: { path: '.kodus/rules.yml' } as any,
        inheritance: {
            inheritable: true,
            exclude: ['repo-x'],
            include: [],
        },
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
    } as IKodyRule;

    const buildService = () => {
        // Capture exactly what the service hands the repository for the update.
        const updateRule = jest
            .fn()
            .mockImplementation((_uuid, ruleId, updateData) =>
                Promise.resolve({ rules: [{ ...updateData, uuid: ruleId }] }),
            );

        const repositoryMock = {
            findByOrganizationId: jest.fn().mockResolvedValue({
                uuid: 'kr-doc-1',
                rules: [existingRule],
            }),
            updateRule,
            // validateRulesLimit lives on the validation service, but addRule
            // must exist in case a branch falls through.
            addRule: jest.fn().mockResolvedValue({ rules: [] }),
        };

        const validateRulesLimit = jest.fn().mockResolvedValue(true);

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any, // eventEmitter
            {} as any, // ruleLikeService
            {} as any, // pullRequestsRepository
            { validateRulesLimit } as any, // kodyRulesValidationService
            {} as any, // mcpManagerService
            {} as any, // promptRunnerService
            {} as any, // observabilityService
            {} as any, // permissionValidationService
            {} as any, // moduleRef
            {} as any, // codeBaseConfigService
        );

        return { service, updateRule };
    };

    const userInfo = { userId: 'u1', userEmail: 'u1@kodus.io' } as any;

    // Pull the `updateData` (3rd arg) the service handed to the repository.
    const capturedUpdate = (updateRule: jest.Mock) => updateRule.mock.calls[0][2];

    it('preserves every untouched field when only the status changes (pause)', async () => {
        const { service, updateRule } = buildService();

        await service.createOrUpdate(
            organizationAndTeamData,
            { uuid: 'rule-1', status: KodyRulesStatus.PAUSED } as any,
            userInfo,
        );

        const update = capturedUpdate(updateRule);

        // The one intended change.
        expect(update.status).toBe(KodyRulesStatus.PAUSED);
        // Everything else carried over from disk — nothing wiped.
        expect(update.title).toBe('Original title');
        expect(update.rule).toBe('original body text');
        expect(update.path).toBe('**/*.ts');
        expect(update.severity).toBe('high');
        expect(update.sourcePath).toBe('.cursorrules');
        expect(update.pinnedSync).toBe(true);
        expect(update.examples).toEqual(existingRule.examples);
        expect(update.contextReferenceId).toBe('ctx-ref-1');
        expect(update.centralizedConfig).toEqual(existingRule.centralizedConfig);
        expect(update.inheritance).toEqual(existingRule.inheritance);
        expect(update.repositoryId).toBe('repo-1');
        expect(update.directoryId).toBe('dir-1');
        // updatedAt is always refreshed.
        expect(update.updatedAt).toBeInstanceOf(Date);
        expect(update.createdAt).toEqual(existingRule.createdAt);
    });

    it('normalizes severity to lower-case while preserving the rest', async () => {
        const { service, updateRule } = buildService();

        await service.createOrUpdate(
            organizationAndTeamData,
            { uuid: 'rule-1', severity: 'Critical' } as any,
            userInfo,
        );

        const update = capturedUpdate(updateRule);
        expect(update.severity).toBe('critical');
        // Title/body untouched.
        expect(update.title).toBe('Original title');
        expect(update.status).toBe(KodyRulesStatus.ACTIVE);
    });

    it('keeps the stored severity when the patch omits it (no undefined clobber)', async () => {
        const { service, updateRule } = buildService();

        // A patch that changes the body but says nothing about severity. The
        // `mergedSeverity ?? existingRule.severity` guard must re-apply 'high'.
        await service.createOrUpdate(
            organizationAndTeamData,
            { uuid: 'rule-1', rule: 'updated body' } as any,
            userInfo,
        );

        const update = capturedUpdate(updateRule);
        expect(update.rule).toBe('updated body');
        expect(update.severity).toBe('high');
    });

    it('sync de-pin path: flipping pinnedSync keeps title/severity/inheritance', async () => {
        const { service, updateRule } = buildService();

        // Mirrors kodyRulesSync.service.ts de-pin: `{ ...rule, pinnedSync: false }`.
        await service.createOrUpdate(
            organizationAndTeamData,
            { ...existingRule, pinnedSync: false } as any,
            userInfo,
        );

        const update = capturedUpdate(updateRule);
        expect(update.pinnedSync).toBe(false);
        expect(update.title).toBe('Original title');
        expect(update.severity).toBe('high');
        expect(update.inheritance).toEqual(existingRule.inheritance);
        expect(update.status).toBe(KodyRulesStatus.ACTIVE);
    });

    it('sync soft-delete path: flipping status to DELETED keeps the rule body', async () => {
        const { service, updateRule } = buildService();

        // Mirrors kodyRulesSync.service.ts soft-delete: `{ ...rule, status: DELETED }`.
        await service.createOrUpdate(
            organizationAndTeamData,
            { ...existingRule, status: KodyRulesStatus.DELETED } as any,
            userInfo,
        );

        const update = capturedUpdate(updateRule);
        expect(update.status).toBe(KodyRulesStatus.DELETED);
        // Soft delete must be reversible — body + source must remain intact.
        expect(update.title).toBe('Original title');
        expect(update.rule).toBe('original body text');
        expect(update.sourcePath).toBe('.cursorrules');
        expect(update.contextReferenceId).toBe('ctx-ref-1');
    });

    it('updateRuleReferences sets the contextReferenceId and preserves the rule', async () => {
        const { service, updateRule } = buildService();

        await service.updateRuleReferences('org-1', 'rule-1', {
            contextReferenceId: 'ctx-ref-2',
        });

        const update = capturedUpdate(updateRule);
        expect(update.contextReferenceId).toBe('ctx-ref-2');
        expect(update.title).toBe('Original title');
        expect(update.rule).toBe('original body text');
        expect(update.severity).toBe('high');
        expect(update.inheritance).toEqual(existingRule.inheritance);
    });
});

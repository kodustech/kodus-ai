import { KodyRulesSyncService } from './kodyRulesSync.service';

/**
 * A synced rule and a rule saved from the UI must end up pointing at the same
 * thing. Reference detection returns no id for a rule that references nothing;
 * both paths clear the rule's pointer then, with null (the repository drops
 * undefined fields, so undefined would leave it in place) — a
 * rule left pointing at an empty revision is loaded on every review, and the
 * review warns that its references resolved to nothing.
 */
describe('KodyRulesSyncService — context reference pointer', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    } as any;

    function build(detectedId: string | undefined) {
        const kodyRulesService = {
            updateRuleReferences: jest.fn().mockResolvedValue(null),
        };
        const detection = {
            detectAndSaveReferences: jest.fn().mockResolvedValue(detectedId),
        };
        const permissionValidationService = {
            resolveTaskSlot: jest.fn().mockResolvedValue(null),
            getSubscriptionStatus: jest.fn().mockResolvedValue('active'),
        };
        const service = new KodyRulesSyncService(
            kodyRulesService as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            permissionValidationService as any,
            {} as any,
            detection as any,
            {} as any,
        );
        jest.spyOn(service as any, 'resolveRepositoryName').mockResolvedValue(
            'app',
        );
        return { service, kodyRulesService };
    }

    const sync = (service: KodyRulesSyncService) =>
        (service as any).processContextReferences({
            ruleId: 'rule-1',
            ruleText: 'Every defensive branch needs a test',
            repositoryId: 'repo-1',
            organizationAndTeamData,
        });

    it('points the rule at the revision detection returned', async () => {
        const { service, kodyRulesService } = build('rev-2');

        await sync(service);

        expect(kodyRulesService.updateRuleReferences).toHaveBeenCalledWith(
            'org-1',
            'rule-1',
            { contextReferenceId: 'rev-2' },
        );
    });

    it('clears the pointer when the rule references nothing', async () => {
        const { service, kodyRulesService } = build(undefined);

        await sync(service);

        expect(kodyRulesService.updateRuleReferences).toHaveBeenCalledWith(
            'org-1',
            'rule-1',
            { contextReferenceId: null },
        );
    });
});

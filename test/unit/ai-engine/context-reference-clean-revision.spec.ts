import { ContextReferenceDetectionService } from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference-detection.service';

// The stale-sync-error bug (found during manual validation of the kody-rules
// hotfix): a rule that once had a sync error kept it FOREVER because a clean
// detection returned early without persisting anything — the errored revision
// stayed latest. A clean detection over an existing revision must commit an
// empty revision that clears the stale state.
describe('ContextReferenceDetectionService — clean detection clears stale revisions', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

    function build(previousRevision: unknown) {
        const promptContextEngine = {
            // Clean detection: no references, no errors, one clean requirement-less result
            detectAndResolveReferences: jest.fn().mockResolvedValue({
                references: [],
                syncErrors: [],
                promptHash: 'hash',
                requirements: [],
                markers: [],
            }),
        };
        const contextReferenceService = {
            getLatestRevision: jest.fn().mockResolvedValue(previousRevision),
            commitRevision: jest.fn().mockResolvedValue({
                pointer: { uuid: 'ctx-ref-1' },
                revision: { uuid: 'rev-new' },
            }),
        };
        const svc = new ContextReferenceDetectionService(
            promptContextEngine as any,
            contextReferenceService as any,
        );
        return { svc, contextReferenceService };
    }

    const fields = [
        {
            text: 'clean rule body, no references',
            path: ['rule'],
            sourceType: 'kody_rule',
        } as any,
    ];

    it('commits an EMPTY revision when a previous revision exists', async () => {
        const { svc, contextReferenceService } = build({ id: 'rev-old' });

        await svc.detectAndSaveReferences({
            entityType: 'kodyRule',
            entityId: 'rule-1',
            fields,
            organizationAndTeamData: orgTeam,
        } as any);

        expect(contextReferenceService.commitRevision).toHaveBeenCalledTimes(1);
        const arg = contextReferenceService.commitRevision.mock.calls[0][0];
        expect(arg.requirements).toEqual([]);
    });

    it('still skips entirely when the entity never had a revision', async () => {
        const { svc, contextReferenceService } = build(null);

        const result = await svc.detectAndSaveReferences({
            entityType: 'kodyRule',
            entityId: 'rule-1',
            fields,
            organizationAndTeamData: orgTeam,
        } as any);

        expect(result).toBeUndefined();
        expect(contextReferenceService.commitRevision).not.toHaveBeenCalled();
    });
});

import { RuntimeRunCancelRequestedSchema } from './run-messages';

// A cancel for a new push names the head it keeps: without one, the worker
// would cancel every live Run of the PR, the new push's own included.

const cancel = (over: Record<string, unknown>) => ({ organizationId: 'org-a', repositoryId: 'repo-1', prNumber: 7, ...over });

describe('RuntimeRunCancelRequested', () => {
    it('a superseded cancel without the head it keeps is refused', () => {
        expect(RuntimeRunCancelRequestedSchema.safeParse(cancel({ reason: 'superseded' })).success).toBe(false);
    });

    it('a superseded cancel with its head, a closed PR and a stop without one are read', () => {
        expect(RuntimeRunCancelRequestedSchema.safeParse(cancel({ reason: 'superseded', headSha: 'a'.repeat(40) })).success).toBe(true);
        expect(RuntimeRunCancelRequestedSchema.safeParse(cancel({ reason: 'pr_closed' })).success).toBe(true);
        expect(RuntimeRunCancelRequestedSchema.safeParse(cancel({ reason: 'stop' })).success).toBe(true);
    });
});

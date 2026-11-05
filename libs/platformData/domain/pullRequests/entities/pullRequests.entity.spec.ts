import { PullRequestsEntity } from './pullRequests.entity';

describe('PullRequestsEntity', () => {
    it('keeps whether the last review ran in heavy mode', () => {
        // The PR list reads the Heavy badge off the entity.
        const heavy = PullRequestsEntity.create({ heavy: true } as any);
        const balanced = PullRequestsEntity.create({ heavy: false } as any);

        expect(heavy.heavy).toBe(true);
        expect(heavy.toObject().heavy).toBe(true);
        expect(heavy.toJson().heavy).toBe(true);
        expect(balanced.heavy).toBe(false);
        expect(PullRequestsEntity.create({} as any).heavy).toBeUndefined();
    });
});

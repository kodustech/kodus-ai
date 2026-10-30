import { CodeReviewSettingsLogRepository } from './codeReviewSettingsLog.repository';

const modelReturning = (docs: unknown[]) => {
    const query = {
        sort: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(docs),
    };
    return { find: jest.fn().mockReturnValue(query), query };
};

// Regression (#2068): the mapper answers an empty result with null and the
// activity log read `.length` off it -> 500 for an org with no logs.
describe('CodeReviewSettingsLogRepository.find', () => {
    it('answers an empty result with an empty list, not null', async () => {
        const model = modelReturning([]);
        const repository = new CodeReviewSettingsLogRepository(model as any);

        await expect(
            repository.find({ organizationId: 'org-1' }),
        ).resolves.toEqual([]);
        expect(model.find).toHaveBeenCalledWith({ organizationId: 'org-1' });
        expect(model.query.sort).toHaveBeenCalledWith({ createdAt: -1 });
    });
});

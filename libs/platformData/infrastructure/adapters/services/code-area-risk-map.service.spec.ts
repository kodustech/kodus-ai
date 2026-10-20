import { CodeAreaRiskMapService } from './code-area-risk-map.service';

it('scopes map reads and writes to organization and repository', async () => {
    const snapshot = {
        version: 'v1',
        files: [],
        directories: [],
        directDirectories: [],
    };
    const findOne = jest.fn().mockReturnValue({
        lean: () => ({ exec: async () => ({ snapshot }) }),
    });
    const updateOne = jest.fn().mockResolvedValue(undefined);
    const service = new CodeAreaRiskMapService({ findOne, updateOne } as any);

    expect(await service.read('org-a', 'repo-b')).toBe(snapshot);
    expect(findOne).toHaveBeenCalledWith(
        { organizationId: 'org-a', repositoryId: 'repo-b' },
        { snapshot: 1 },
    );

    await service.save('org-a', 'repo-b', snapshot as any);
    expect(updateOne).toHaveBeenCalledWith(
        { organizationId: 'org-a', repositoryId: 'repo-b' },
        { $set: { snapshot } },
        { upsert: true },
    );
});

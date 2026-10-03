import { CodeReviewSettingsLogRepository } from './codeReviewSettingsLog.repository';

const modelReturning = (docs: unknown[]) => {
    const query = {
        sort: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(docs),
    };
    return { find: jest.fn().mockReturnValue(query), query };
};

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

    it('maps every stored log to an entity, newest first as queried', async () => {
        const model = modelReturning([
            { _doc: { _id: 'log-2', organizationId: 'org-1', action: 'edit' } },
            {
                _doc: {
                    _id: 'log-1',
                    organizationId: 'org-1',
                    action: 'create',
                },
            },
        ]);
        const repository = new CodeReviewSettingsLogRepository(model as any);

        const logs = await repository.find({ organizationId: 'org-1' });

        expect(logs.map((log) => [log.uuid, log.action])).toEqual([
            ['log-2', 'edit'],
            ['log-1', 'create'],
        ]);
    });
});

describe('CodeReviewSettingsLogRepository.create', () => {
    it('stores the log and returns it as an entity', async () => {
        const model = {
            create: jest.fn().mockResolvedValue({
                _doc: { _id: 'log-9', organizationId: 'org-1', action: 'edit' },
            }),
        };
        const repository = new CodeReviewSettingsLogRepository(model as any);
        const log = { organizationId: 'org-1', action: 'edit' } as any;

        const saved = await repository.create(log);

        expect(model.create).toHaveBeenCalledWith(log);
        expect([saved.uuid, saved.organizationId, saved.action]).toEqual([
            'log-9',
            'org-1',
            'edit',
        ]);
    });
});

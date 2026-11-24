import { SecurityScanScheduleRepository } from './security-scan-schedule.repository';

const repository = { platform: 'GITHUB', host: 'github.com', id: 'repo-1' };
const settings = {
    teamId: 'team-1',
    cadence: 'daily' as const,
    budget: { maxUsd: 5 },
    mode: 'incremental' as const,
    nextRunAt: '2026-11-25T03:00:00.000Z',
};
// One schedule per organization and repository (platform, host, id).
const FILTER = {
    'organizationId': 'org-1',
    'repository.platform': 'GITHUB',
    'repository.host': 'github.com',
    'repository.id': 'repo-1',
};
const OPTIONS = { upsert: true, new: true };

function withModel(write: jest.Mock) {
    const model = {
        findOneAndUpdate: jest.fn((...args: unknown[]) => ({
            lean: () => ({ exec: () => write(...args) }),
        })),
    };
    const doc = { _id: 'sch-1', organizationId: 'org-1', repository, ...settings, enabled: true };
    write.mockImplementation(async () => doc);
    return { schedules: new SecurityScanScheduleRepository(model as any), model };
}

describe('SecurityScanScheduleRepository.save', () => {
    it('leaves the stored state alone when saved without saying, and enables a new one, in one write', async () => {
        const { schedules, model } = withModel(jest.fn());

        await schedules.save('org-1', repository, settings);

        const [filter, update, options] = model.findOneAndUpdate.mock.calls[0] as any;
        expect(filter).toEqual(FILTER);
        expect(options).toEqual(OPTIONS);
        expect(update.$set).not.toHaveProperty('enabled');
        expect(update.$setOnInsert).toEqual({ enabled: true });
    });

    it('pauses or resumes when told', async () => {
        const { schedules, model } = withModel(jest.fn());

        await schedules.save('org-1', repository, { ...settings, enabled: false });

        const [filter, update, options] = model.findOneAndUpdate.mock.calls[0] as any;
        expect(filter).toEqual(FILTER);
        expect(options).toEqual(OPTIONS);
        expect(update.$set.enabled).toBe(false);
        expect(update.$setOnInsert).toBeUndefined();
    });

    it('stores no enabled that is not a boolean', async () => {
        const { schedules, model } = withModel(jest.fn());

        await schedules.save('org-1', repository, { ...settings, enabled: null as any });

        const [, update] = model.findOneAndUpdate.mock.calls[0] as any;
        expect(update.$set).not.toHaveProperty('enabled');
        expect(update.$setOnInsert).toEqual({ enabled: true });
    });

    it('lands a save that lost the insert race as the same upsert again', async () => {
        const write = jest.fn();
        const { schedules, model } = withModel(write);
        write.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));

        await expect(schedules.save('org-1', repository, settings)).resolves.toMatchObject({ uuid: 'sch-1' });
        expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);
        const [first, retry] = model.findOneAndUpdate.mock.calls as any[];
        expect(retry[0]).toEqual(FILTER);
        expect(retry[1]).toEqual(first[1]);
        expect(retry[2]).toEqual(OPTIONS);
    });
});

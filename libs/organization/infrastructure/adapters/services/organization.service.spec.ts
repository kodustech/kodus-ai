import { EventEmitter2 } from '@nestjs/event-emitter';

import { ORGANIZATION_DELETED_EVENT, OrganizationDeletedEvent } from '@libs/core/domain/events/organization-deleted.event';

import { OrganizationService } from './organization.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));

describe('OrganizationService.deleteOne', () => {
    const repository = () => ({ deleteOne: jest.fn(async () => undefined), findOne: jest.fn(async () => ({ uuid: 'org-by-name' })) });

    it('tells listeners the organization is gone once the row is deleted', async () => {
        const repo = repository();
        const events = new EventEmitter2();
        const heard: OrganizationDeletedEvent[] = [];
        events.on(ORGANIZATION_DELETED_EVENT, (e: OrganizationDeletedEvent) => heard.push(e));

        await new OrganizationService(repo as never, events).deleteOne({ uuid: 'org-1' });

        expect(repo.deleteOne).toHaveBeenCalledWith({ uuid: 'org-1' });
        expect(heard).toEqual([new OrganizationDeletedEvent('org-1')]);
    });

    it('says nothing when the delete fails, so nothing is purged for an organization that still exists', async () => {
        const repo = repository();
        repo.deleteOne.mockRejectedValue(new Error('No matching organization found'));
        const events = new EventEmitter2();
        const emit = jest.spyOn(events, 'emit');

        await expect(new OrganizationService(repo as never, events).deleteOne({ uuid: 'org-1' })).rejects.toThrow('No matching organization');

        expect(emit).not.toHaveBeenCalled();
    });

    it('never fails the deletion because a listener threw, and works where no event module is loaded', async () => {
        const events = new EventEmitter2();
        jest.spyOn(events, 'emit').mockImplementation(() => {
            throw new Error('listener blew up');
        });
        await expect(new OrganizationService(repository() as never, events).deleteOne({ uuid: 'org-1' })).resolves.toBeUndefined();
        await expect(new OrganizationService(repository() as never).deleteOne({ uuid: 'org-1' })).resolves.toBeUndefined();
    });

    it('resolves the id of an organization deleted by another filter, so the event still names it', async () => {
        const events = new EventEmitter2();
        const heard: OrganizationDeletedEvent[] = [];
        events.on(ORGANIZATION_DELETED_EVENT, (e: OrganizationDeletedEvent) => heard.push(e));
        await new OrganizationService(repository() as never, events).deleteOne({ name: 'temp' });
        expect(heard).toEqual([new OrganizationDeletedEvent('org-by-name')]);
    });
});

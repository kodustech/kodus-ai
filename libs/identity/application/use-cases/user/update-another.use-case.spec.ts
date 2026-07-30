import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { USER_SERVICE_TOKEN } from '@libs/identity/domain/user/contracts/user.service.contract';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { ORGANIZATION_SERVICE_TOKEN } from '@libs/organization/domain/organization/contracts/organization.service.contract';
import { TEAM_SERVICE_TOKEN } from '@libs/organization/domain/team/contracts/team.service.contract';
import { TEAM_MEMBERS_SERVICE_TOKEN } from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';

import { UpdateAnotherUserUseCase } from './update-another.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('UpdateAnotherUserUseCase — org.role_changed emit', () => {
    let useCase: UpdateAnotherUserUseCase;
    let usersService: { find: jest.Mock; findOne: jest.Mock; update: jest.Mock };
    let orgService: { findOne: jest.Mock };
    let teamService: { findOne: jest.Mock };
    let teamMembers: { findOne: jest.Mock };
    let eventEmitter: { emit: jest.Mock };
    let notify: { emit: jest.Mock };

    const TARGET_USER = {
        uuid: 'target-1',
        email: 'target@acme.com',
        role: Role.CONTRIBUTOR,
    };
    const ORG = { uuid: 'org-1', name: 'Acme Inc' };
    const TEAM = { uuid: 'team-1' };
    const TEAM_MEMBER = {
        team: TEAM,
        organization: ORG,
    };
    const ACTING_USER = { uuid: 'admin-1', email: 'admin@acme.com' };

    beforeEach(async () => {
        usersService = {
            find: jest.fn(),
            findOne: jest.fn().mockImplementation(async ({ uuid }: any) =>
                uuid === ACTING_USER.uuid ? ACTING_USER : TARGET_USER,
            ),
            update: jest
                .fn()
                .mockResolvedValue({ toObject: () => TARGET_USER }),
        };
        orgService = { findOne: jest.fn().mockResolvedValue(ORG) };
        teamService = { findOne: jest.fn().mockResolvedValue(TEAM) };
        teamMembers = { findOne: jest.fn().mockResolvedValue(TEAM_MEMBER) };
        eventEmitter = { emit: jest.fn() };
        notify = { emit: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                UpdateAnotherUserUseCase,
                { provide: USER_SERVICE_TOKEN, useValue: usersService },
                { provide: ORGANIZATION_SERVICE_TOKEN, useValue: orgService },
                { provide: TEAM_SERVICE_TOKEN, useValue: teamService },
                { provide: TEAM_MEMBERS_SERVICE_TOKEN, useValue: teamMembers },
                { provide: EventEmitter2, useValue: eventEmitter },
                { provide: NotificationService, useValue: notify },
            ],
        }).compile();

        useCase = module.get(UpdateAnotherUserUseCase);
    });

    it('emits org.role_changed when role transitions to a different value', async () => {
        await useCase.execute(
            ACTING_USER.uuid,
            TARGET_USER.uuid,
            { role: Role.OWNER, status: undefined as any },
            ORG.uuid,
        );

        expect(notify.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                event: NotificationEvent.ORG_ROLE_CHANGED,
                organizationId: 'org-1',
                // Audience (org owners) is config-driven via the catalog's
                // `defaultRoles`, so the emit passes no recipients.
                payload: {
                    affectedUserEmail: 'target@acme.com',
                    previousRole: Role.CONTRIBUTOR,
                    newRole: Role.OWNER,
                    changedBy: 'admin@acme.com',
                    organizationName: 'Acme Inc',
                },
            }),
        );
    });

    it('does NOT emit when role is unchanged', async () => {
        await useCase.execute(
            ACTING_USER.uuid,
            TARGET_USER.uuid,
            { role: Role.CONTRIBUTOR, status: undefined as any },
            ORG.uuid,
        );

        expect(notify.emit).not.toHaveBeenCalled();
    });

    it('does NOT emit when role is not in the update payload', async () => {
        await useCase.execute(
            ACTING_USER.uuid,
            TARGET_USER.uuid,
            { role: undefined as any, status: 'active' as any },
            ORG.uuid,
        );

        expect(notify.emit).not.toHaveBeenCalled();
    });

    it('still emits the audit-log event when role changes (existing behaviour preserved)', async () => {
        await useCase.execute(
            ACTING_USER.uuid,
            TARGET_USER.uuid,
            { role: Role.OWNER, status: undefined as any },
            ORG.uuid,
        );

        expect(eventEmitter.emit).toHaveBeenCalled();
    });

    it('swallows notification failures so the update still returns', async () => {
        notify.emit.mockRejectedValueOnce(new Error('outbox down'));

        const result = await useCase.execute(
            ACTING_USER.uuid,
            TARGET_USER.uuid,
            { role: Role.OWNER, status: undefined as any },
            ORG.uuid,
        );

        expect(result).toBeDefined();
    });
});

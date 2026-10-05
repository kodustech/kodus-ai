import { NotFoundException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import { TEAM_SERVICE_TOKEN } from '@libs/organization/domain/team/contracts/team.service.contract';
import { TEAM_MEMBERS_SERVICE_TOKEN } from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

import { CreateOrUpdateTeamMembersUseCase } from './create.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('CreateOrUpdateTeamMembersUseCase — organization isolation', () => {
    const TEAM_ORG: Record<string, string> = {
        'team-acme': 'org-acme',
        'team-globex': 'org-globex',
    };

    const build = async () => {
        const teamMembers = {
            updateOrCreateMembers: jest.fn().mockResolvedValue({ results: [] }),
        };
        const teams = {
            findOneOrganizationIdByTeamId: jest.fn((teamId: string) =>
                Promise.resolve(TEAM_ORG[teamId]),
            ),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CreateOrUpdateTeamMembersUseCase,
                { provide: TEAM_MEMBERS_SERVICE_TOKEN, useValue: teamMembers },
                { provide: TEAM_SERVICE_TOKEN, useValue: teams },
                { provide: EventEmitter2, useValue: { emit: jest.fn() } },
                {
                    provide: TelemetryService,
                    useValue: { memberInvited: jest.fn() },
                },
                {
                    provide: REQUEST,
                    useValue: {
                        user: {
                            uuid: 'owner-acme',
                            email: 'owner@acme.com',
                            organization: { uuid: 'org-acme' },
                        },
                    },
                },
            ],
        }).compile();

        return {
            useCase: module.get(CreateOrUpdateTeamMembersUseCase),
            teamMembers,
        };
    };

    const MEMBERS = [{ email: 'new@acme.com', role: 'member' }] as any[];

    it('does not add members to a team of another organization', async () => {
        const { useCase, teamMembers } = await build();

        await expect(
            useCase.execute('team-globex', MEMBERS),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(teamMembers.updateOrCreateMembers).not.toHaveBeenCalled();
    });

    it('rejects a team that does not exist', async () => {
        const { useCase, teamMembers } = await build();

        await expect(
            useCase.execute('team-missing', MEMBERS),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(teamMembers.updateOrCreateMembers).not.toHaveBeenCalled();
    });

    it('still adds members to a team of the caller organization', async () => {
        const { useCase, teamMembers } = await build();

        await useCase.execute('team-acme', MEMBERS);

        expect(teamMembers.updateOrCreateMembers).toHaveBeenCalledWith(
            MEMBERS,
            { organizationId: 'org-acme', teamId: 'team-acme' },
            'owner@acme.com',
        );
    });
});

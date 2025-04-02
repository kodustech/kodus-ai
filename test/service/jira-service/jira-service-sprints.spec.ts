import { JiraService } from '@/core/infrastructure/adapters/services/jira/jira.service';
import { JiraServiceTestUtils } from './testUtils';
import mockedParameters from './mocks/params';
import jsonData from './mocks/jsonData';
import { SPRINT_STATE } from '@/core/domain/sprint/enum/sprintState.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { NotFoundException } from '@nestjs/common/exceptions/not-found.exception';

describe('JiraService', () => {
    let service: JiraService;

    beforeAll(async () => {
        await JiraServiceTestUtils.setup();
        service = JiraServiceTestUtils.getService();
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        await JiraServiceTestUtils.clearDatabase();
        await JiraServiceTestUtils.setupTestData();
    });

    afterAll(async () => {
        await JiraServiceTestUtils.closeConnection();
    });
    describe('getSprints', () => {
        it('should fetch sprints correctly', async () => {
            const integration = mockedParameters.INTEGRATION;
            const integrationConfig = {
                boardId: '11',
                projectId: '10014',
                projectKey: 'SGE',
            };
            const organizationAndTeamData =
                mockedParameters.ORGANIZATION_AND_TEAM_DATA;
            const sprintState = SPRINT_STATE.ACTIVE;

            const mockSprintData = {
                maxResults: 50,
                startAt: 0,
                total: 1,
                isLast: true,
                values: [
                    {
                        id: 17,
                        self: 'https://api.atlassian.com/ex/jira/30b864d3-bf6e-4baa-8f54-432280bb229c/rest/agile/1.0/sprint/17',
                        state: 'active',
                        name: 'SGE Sprint 2',
                        startDate: '2024-08-20T14:52:51.854Z',
                        endDate: '2024-08-26T03:00:00.000Z',
                        createdDate: '2024-08-20T14:52:21.347Z',
                        originBoardId: 11,
                        goal: '',
                    },
                ],
            };

            jest.spyOn(service['axiosClient'], 'get').mockResolvedValue({
                data: mockSprintData,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {} as any,
            });

            const result = await (service as any).getSprints(
                integration,
                integrationConfig,
                organizationAndTeamData,
                sprintState,
            );

            expect(service['axiosClient'].get).toHaveBeenCalledWith(
                `${process.env.API_JIRA_BASE_URL}/CLOUD_ID/${process.env.API_JIRA_URL_API_VERSION_1}/board/11/sprint`,
                {
                    params: { state: sprintState },
                    headers: {
                        Authorization: 'Bearer AUTH_TOKEN',
                        organizationId: mockedParameters.ORGANIZATION_ID,
                        platformType: PlatformType.JIRA,
                    },
                },
            );

            expect(result).toEqual(mockSprintData.values);
        });

        it('should return null when no sprints are found', async () => {
            const integration = mockedParameters.INTEGRATION;
            const integrationConfig = {
                boardId: '11',
                projectId: '10014',
                projectKey: 'SGE',
            };
            const organizationAndTeamData =
                mockedParameters.ORGANIZATION_AND_TEAM_DATA;
            const sprintState = undefined;

            const mockEmptySprintData = {
                maxResults: 50,
                startAt: 0,
                total: 0,
                isLast: true,
                values: [],
            };

            jest.spyOn(service['axiosClient'], 'get').mockResolvedValue({
                data: mockEmptySprintData,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {} as any,
            });

            const result = await (service as any).getSprints(
                integration,
                integrationConfig,
                organizationAndTeamData,
                sprintState,
            );

            expect(result).toBeNull();
        });
    });

    describe('getCurrentSprintForTeam', () => {
        it('should fetch and return the current sprint for the team', async () => {
            const organizationAndTeamData =
                mockedParameters.ORGANIZATION_AND_TEAM_DATA;

            const mockIntegration = mockedParameters.INTEGRATION;
            const mockIntegrationConfig = {
                boardId: '11',
                projectId: '10014',
                projectKey: 'SGE',
            };

            const mockSprintData = [
                {
                    id: 17,
                    self: 'https://api.atlassian.com/ex/jira/30b864d3-bf6e-4baa-8f54-432280bb229c/rest/agile/1.0/sprint/17',
                    state: 'active',
                    name: 'SGE Sprint 2',
                    startDate: '2024-08-20T14:52:51.854Z',
                    endDate: '2024-08-26T03:00:00.000Z',
                    createdDate: '2024-08-20T14:52:21.347Z',
                    originBoardId: 11,
                    goal: '',
                },
            ];

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockResolvedValue(mockIntegrationConfig);
            jest.spyOn(service as any, 'getSprints').mockResolvedValue(
                mockSprintData,
            );

            const result = await service.getCurrentSprintForTeam(
                organizationAndTeamData,
            );

            expect(
                service['ensureAuthenticatedIntegration'],
            ).toHaveBeenCalledWith(organizationAndTeamData);

            expect(
                service['integrationConfigService']
                    .findIntegrationConfigFormatted,
            ).toHaveBeenCalledWith(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                organizationAndTeamData,
            );

            expect(service['getSprints']).toHaveBeenCalledWith(
                mockIntegration,
                mockIntegrationConfig,
                organizationAndTeamData,
                SPRINT_STATE.ACTIVE,
            );

            expect(result).toHaveProperty('id', 17);
            expect(result).toHaveProperty('name', 'SGE Sprint 2');
            expect(result).toHaveProperty(
                'startDate',
                new Date('2024-08-20T14:52:51.854Z'),
            );
            expect(result).toHaveProperty(
                'endDate',
                new Date('2024-08-26T03:00:00.000Z'),
            );
            expect(result).toHaveProperty('state', 'active');
            expect(result).toHaveProperty('goal', '');
        });
    });

    describe('getAllSprintsForTeam', () => {
        it('should fetch and return all sprints for the team', async () => {
            const organizationAndTeamData =
                mockedParameters.ORGANIZATION_AND_TEAM_DATA;

            const mockIntegration = mockedParameters.INTEGRATION;
            const mockIntegrationConfig = {
                boardId: '11',
                projectId: '10014',
                projectKey: 'SGE',
            };

            const mockSprintData = [
                {
                    id: 16,
                    self: 'https://api.atlassian.com/ex/jira/30b864d3-bf6e-4baa-8f54-432280bb229c/rest/agile/1.0/sprint/16',
                    state: 'closed',
                    name: 'SGE Sprint 1',
                    startDate: '2024-08-12T14:41:00.000Z',
                    endDate: '2024-08-19T03:00:00.000Z',
                    completeDate: '2024-08-20T14:52:32.771Z',
                    createdDate: '2024-08-20T14:38:05.403Z',
                    originBoardId: 11,
                    goal: '',
                },
                {
                    id: 17,
                    self: 'https://api.atlassian.com/ex/jira/30b864d3-bf6e-4baa-8f54-432280bb229c/rest/agile/1.0/sprint/17',
                    state: 'active',
                    name: 'SGE Sprint 2',
                    startDate: '2024-08-20T14:52:51.854Z',
                    endDate: '2024-08-26T03:00:00.000Z',
                    createdDate: '2024-08-20T14:52:21.347Z',
                    originBoardId: 11,
                    goal: '',
                },
            ];

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockResolvedValue(mockIntegrationConfig);

            jest.spyOn(service as any, 'getSprints').mockResolvedValue(
                mockSprintData,
            );

            const result = await service.getAllSprintsForTeam(
                organizationAndTeamData,
            );

            expect(
                service['ensureAuthenticatedIntegration'],
            ).toHaveBeenCalledWith(organizationAndTeamData);

            expect(
                service['integrationConfigService']
                    .findIntegrationConfigFormatted,
            ).toHaveBeenCalledWith(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                organizationAndTeamData,
            );

            expect(service['getSprints']).toHaveBeenCalledWith(
                mockIntegration,
                mockIntegrationConfig,
                organizationAndTeamData,
            );

            expect(result).toHaveLength(2);

            expect(result[0]).toEqual({
                id: 16,
                name: 'SGE Sprint 1',
                startDate: new Date('2024-08-12T14:41:00.000Z'),
                endDate: new Date('2024-08-19T03:00:00.000Z'),
                completeDate: new Date('2024-08-20T14:52:32.771Z'),
                state: 'closed',
                goal: '',
                originBoardId: 11,
            });

            expect(result[1].id).toBe(17);
            expect(result[1].name).toBe('SGE Sprint 2');
            expect(result[1].startDate).toEqual(
                new Date('2024-08-20T14:52:51.854Z'),
            );
            expect(result[1].endDate).toEqual(
                new Date('2024-08-26T03:00:00.000Z'),
            );
            //expect(result[1].completeDate).toBeNull();
            expect(result[1].state).toBe('active');
            expect(result[1].goal).toBe('');
        });

        it('should throw NotFoundException when integration is not found', async () => {
            const organizationAndTeamData =
                mockedParameters.ORGANIZATION_AND_TEAM_DATA;

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(null);

            await expect(
                service.getAllSprintsForTeam(organizationAndTeamData),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('getLastCompletedSprintForTeam', () => {
        it('should fetch and return the last completed sprint for the team', async () => {
            const organizationAndTeamData =
                mockedParameters.ORGANIZATION_AND_TEAM_DATA;

            const mockIntegration = mockedParameters.INTEGRATION;
            const mockIntegrationConfig = {
                boardId: '11',
                projectId: '10014',
                projectKey: 'SGE',
            };

            const mockSprintData = [
                {
                    id: 16,
                    self: 'https://api.atlassian.com/ex/jira/30b864d3-bf6e-4baa-8f54-432280bb229c/rest/agile/1.0/sprint/16',
                    state: 'closed',
                    name: 'SGE Sprint 1',
                    startDate: '2024-08-12T14:41:00.000Z',
                    endDate: '2024-08-19T03:00:00.000Z',
                    completeDate: '2024-08-20T14:52:32.771Z',
                    createdDate: '2024-08-20T14:38:05.403Z',
                    originBoardId: 11,
                    goal: '',
                },
            ];

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockResolvedValue(mockIntegrationConfig);

            jest.spyOn(service as any, 'getSprints').mockResolvedValue(
                mockSprintData,
            );

            const result = await service.getLastCompletedSprintForTeam(
                organizationAndTeamData,
            );

            expect(
                service['ensureAuthenticatedIntegration'],
            ).toHaveBeenCalledWith(organizationAndTeamData);

            expect(
                service['integrationConfigService']
                    .findIntegrationConfigFormatted,
            ).toHaveBeenCalledWith(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                organizationAndTeamData,
            );

            expect(service['getSprints']).toHaveBeenCalledWith(
                mockIntegration,
                mockIntegrationConfig,
                organizationAndTeamData,
                SPRINT_STATE.CLOSED,
            );

            expect(result).toEqual({
                id: 16,
                name: 'SGE Sprint 1',
                startDate: new Date('2024-08-12T14:41:00.000Z'),
                endDate: new Date('2024-08-19T03:00:00.000Z'),
                completeDate: new Date('2024-08-20T14:52:32.771Z'),
                state: 'closed',
                goal: '',
                originBoardId: 11,
            });
        });

        it('should return undefined when there are no completed sprints', async () => {
            const organizationAndTeamData =
                mockedParameters.ORGANIZATION_AND_TEAM_DATA;

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockResolvedValue({
                boardId: '11',
                projectId: '10014',
                projectKey: 'SGE',
            });

            jest.spyOn(service as any, 'getSprints').mockResolvedValue([]);

            const result = await service.getLastCompletedSprintForTeam(
                organizationAndTeamData,
            );

            expect(result).toBeUndefined();
        });

        it('should throw NotFoundException when integration is not found', async () => {
            const organizationAndTeamData =
                mockedParameters.ORGANIZATION_AND_TEAM_DATA;

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(null);

            await expect(
                service.getLastCompletedSprintForTeam(organizationAndTeamData),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('getNextSprintForTeam', () => {
        const organizationAndTeamData =
            mockedParameters.ORGANIZATION_AND_TEAM_DATA;

        it('should return the next sprint for the team', async () => {
            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(service, 'getAllSprintsForTeam').mockResolvedValue(
                jsonData.GET_NEXT_SPRINT_FOR_TEAM_DATA.map((sprint) => ({
                    ...sprint,
                    id: sprint.id.toString(),
                    startDate: new Date(sprint.startDate),
                    endDate: new Date(sprint.endDate),
                    completeDate: sprint.completeDate
                        ? new Date(sprint.completeDate)
                        : null,
                    state: sprint.state as SPRINT_STATE,
                    originBoardId: 11,
                })),
            );

            const result = await service.getNextSprintForTeam(
                organizationAndTeamData,
                '17',
                11,
            );

            expect(
                service['ensureAuthenticatedIntegration'],
            ).toHaveBeenCalledWith(organizationAndTeamData);
            expect(service.getAllSprintsForTeam).toHaveBeenCalledWith(
                organizationAndTeamData,
                11,
            );

            expect(result).toEqual({
                id: '18',
                name: 'SGE Sprint 3',
                startDate: new Date('2024-08-26T03:00:00.000Z'),
                endDate: new Date('2024-09-02T03:00:00.000Z'),
                completeDate: null,
                state: 'future',
                goal: '',
                originBoardId: 11,
            });
        });

        it('should return null if current sprint is not found', async () => {
            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(service, 'getAllSprintsForTeam').mockResolvedValue(
                jsonData.GET_NEXT_SPRINT_FOR_TEAM_DATA.map((sprint) => ({
                    ...sprint,
                    id: sprint.id.toString(),
                    startDate: new Date(sprint.startDate),
                    endDate: new Date(sprint.endDate),
                    completeDate: sprint.completeDate
                        ? new Date(sprint.completeDate)
                        : null,
                    state: sprint.state as SPRINT_STATE,
                })),
            );

            const result = await service.getNextSprintForTeam(
                organizationAndTeamData,
                '999',
            );
            expect(result).toBeNull();
        });

        it('should return null if there are no sprints', async () => {
            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(service, 'getAllSprintsForTeam').mockResolvedValue([]);

            const result = await service.getNextSprintForTeam(
                organizationAndTeamData,
                '17',
            );

            expect(result).toBeNull();
        });

        it('should throw NotFoundException when integration is not found', async () => {
            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(null);

            await expect(
                service.getNextSprintForTeam(organizationAndTeamData, '17'),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('getLastCompletedSprintForTeam', () => {
        const organizationAndTeamData =
            mockedParameters.ORGANIZATION_AND_TEAM_DATA;

        it('should fetch and return the last completed sprint for the team', async () => {
            const mockIntegration = mockedParameters.INTEGRATION;
            const mockIntegrationConfig = {
                boardId: '11',
                projectId: '10014',
                projectKey: 'SGE',
            };

            const mockSprintData = [
                {
                    id: 16,
                    self: 'https://api.atlassian.com/ex/jira/30b864d3-bf6e-4baa-8f54-432280bb229c/rest/agile/1.0/sprint/16',
                    state: 'closed',
                    name: 'SGE Sprint 1',
                    startDate: '2024-08-12T14:41:00.000Z',
                    endDate: '2024-08-19T03:00:00.000Z',
                    completeDate: '2024-08-20T14:52:32.771Z',
                    createdDate: '2024-08-20T14:38:05.403Z',
                    originBoardId: 11,
                    goal: '',
                },
            ];

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockResolvedValue(mockIntegrationConfig);

            jest.spyOn(service as any, 'getSprints').mockResolvedValue(
                mockSprintData,
            );

            const result = await service.getLastCompletedSprintForTeam(
                organizationAndTeamData,
            );

            expect(
                service['integrationConfigService']
                    .findIntegrationConfigFormatted,
            ).toHaveBeenCalledWith(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                organizationAndTeamData,
            );

            expect(service['getSprints']).toHaveBeenCalledWith(
                mockIntegration,
                mockIntegrationConfig,
                organizationAndTeamData,
                SPRINT_STATE.CLOSED,
            );

            expect(result).toEqual({
                id: 16,
                name: 'SGE Sprint 1',
                startDate: new Date('2024-08-12T14:41:00.000Z'),
                endDate: new Date('2024-08-19T03:00:00.000Z'),
                completeDate: new Date('2024-08-20T14:52:32.771Z'),
                state: 'closed',
                goal: '',
                originBoardId: 11,
            });
        });

        it('should return undefined when there are no completed sprints', async () => {
            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockResolvedValue({
                boardId: '11',
                projectId: '10014',
                projectKey: 'SGE',
            });

            jest.spyOn(service as any, 'getSprints').mockResolvedValue([]);

            const result = await service.getLastCompletedSprintForTeam(
                organizationAndTeamData,
            );

            expect(result).toBeUndefined();
        });

        it('should sort sprints correctly when multiple completed sprints exist', async () => {
            const mockMultipleSprintData = [
                {
                    id: 15,
                    state: 'closed',
                    name: 'SGE Sprint 0',
                    startDate: '2024-08-05T14:41:00.000Z',
                    endDate: '2024-08-12T03:00:00.000Z',
                    completeDate: '2024-08-13T14:52:32.771Z',
                    goal: '',
                    originBoardId: 11,
                },
                {
                    id: 16,
                    state: 'closed',
                    name: 'SGE Sprint 1',
                    startDate: '2024-08-12T14:41:00.000Z',
                    endDate: '2024-08-19T03:00:00.000Z',
                    completeDate: '2024-08-20T14:52:32.771Z',
                    goal: '',
                    originBoardId: 11,
                },
            ];

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockResolvedValue({
                boardId: '11',
                projectId: '10014',
                projectKey: 'SGE',
            });

            jest.spyOn(service as any, 'getSprints').mockResolvedValue(
                mockMultipleSprintData,
            );

            const result = await service.getLastCompletedSprintForTeam(
                organizationAndTeamData,
            );

            expect(result.id).toBe(16);
            expect(result.name).toBe('SGE Sprint 1');
        });
    });

    describe('getSprintByProjectManagementId', () => {
        const organizationAndTeamData =
            mockedParameters.ORGANIZATION_AND_TEAM_DATA;
        const projectManagementSprintId = '16';

        it('should fetch and return the sprint by project management id', async () => {
            const mockIntegration = mockedParameters.INTEGRATION;
            const mockSprintData = {
                id: 16,
                self: 'https://api.atlassian.com/ex/jira/30b864d3-bf6e-4baa-8f54-432280bb229c/rest/agile/1.0/sprint/16',
                state: 'closed',
                name: 'SGE Sprint 1',
                startDate: '2024-08-12T14:41:00.000Z',
                endDate: '2024-08-19T03:00:00.000Z',
                completeDate: '2024-08-20T14:52:32.771Z',
                createdDate: '2024-08-20T14:38:05.403Z',
                originBoardId: 11,
                goal: '',
            };

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(service['axiosClient'], 'get').mockResolvedValue({
                data: mockSprintData,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {
                    headers: undefined,
                },
            });

            const result = await service.getSprintByProjectManagementId(
                organizationAndTeamData,
                projectManagementSprintId,
            );
            expect(service['axiosClient'].get).toHaveBeenCalledWith(
                `${process.env.API_JIRA_BASE_URL}/${mockIntegration.authIntegration.authDetails.cloudId}/${process.env.API_JIRA_URL_API_VERSION_1}/sprint/${projectManagementSprintId}`,
                {
                    headers: {
                        Authorization: `Bearer ${mockIntegration.authIntegration.authDetails.authToken}`,
                        organizationId: organizationAndTeamData.organizationId,
                        platformType: PlatformType.JIRA,
                    },
                },
            );

            expect(result).toEqual({
                id: 16,
                name: 'SGE Sprint 1',
                startDate: new Date('2024-08-12T14:41:00.000Z'),
                endDate: new Date('2024-08-19T03:00:00.000Z'),
                completeDate: new Date('2024-08-20T14:52:32.771Z'),
                state: 'closed',
                goal: '',
                originBoardId: 11,
            });
        });

        it('should handle sprint without completeDate', async () => {
            const mockSprintData = {
                id: 17,
                self: 'https://api.atlassian.com/ex/jira/30b864d3-bf6e-4baa-8f54-432280bb229c/rest/agile/1.0/sprint/17',
                state: 'active',
                name: 'SGE Sprint 2',
                startDate: '2024-08-20T14:52:51.854Z',
                endDate: '2024-08-26T03:00:00.000Z',
                completeDate: null,
                createdDate: '2024-08-20T14:52:21.347Z',
                originBoardId: 11,
                goal: '',
            };

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(service['axiosClient'], 'get').mockResolvedValue({
                data: mockSprintData,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {
                    headers: undefined,
                },
            });

            const result = await service.getSprintByProjectManagementId(
                organizationAndTeamData,
                '17',
            );

            expect(result.completeDate).toBeNull();
        });
    });
});

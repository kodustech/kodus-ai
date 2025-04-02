import { JiraService } from '@/core/infrastructure/adapters/services/jira/jira.service';
import { AxiosJiraService } from '@/config/axios/microservices/jira.axios';
import { NotFoundException } from '@nestjs/common/exceptions';
import { JiraServiceTestUtils } from './testUtils';
import mockedFunctions from './mocks/functions';
import mockedParameters from './mocks/params';
import jsonData from './mocks/jsonData';

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

    describe('getDomain', () => {
        it('should return domain', async () => {
            JiraServiceTestUtils.setupAxiosJiraService(mockedFunctions.getDomain().data);

            const result = await service.getDomain({
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
            });

            expect(result[0]).toEqual(
                expect.objectContaining({
                    name: 'kodustech',
                    url: 'https://kodustech.atlassian.net',
                    selected: expect.any(Boolean),
                }),
            );
        });
    });

    describe('getProject', () => {
        it('should return the correct projects filtered and formatted', async () => {
            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            AxiosJiraService.prototype.get = jest.fn().mockResolvedValue({
                data: jsonData.PROJECT_RESPONSE,
            });

            const params = {
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
            };

            const result = await service.getProject(params);

            expect(AxiosJiraService.prototype.get).toHaveBeenCalledWith(
                expect.stringContaining('/rest/api/3/project/search'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: `Bearer AUTH_TOKEN`,
                        organizationId: mockedParameters.ORGANIZATION_ID,
                        platformType: 'JIRA',
                    }),
                }),
            );

            expect(result).toEqual(mockedFunctions.getProject().data);

            expect(result[4]).toEqual(
                expect.objectContaining({
                    name: 'QA - Sistema Escolar',
                    id: '10013',
                    key: 'QAS',
                    selected: false,
                }),
            );
        });
    });

    describe('getBoard', () => {
        it('should return the correct boards filtered and formatted', async () => {
            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            AxiosJiraService.prototype.get = jest.fn().mockResolvedValue({
                data: jsonData.BOARD_RESPONSE,
            });

            const params = {
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
                projectSelected: {
                    id: mockedParameters.PROJECT_ID,
                },
            };

            const result = await service.getBoard(params);

            expect(AxiosJiraService.prototype.get).toHaveBeenCalledWith(
                expect.stringContaining('/rest/agile/1.0/board'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: `Bearer AUTH_TOKEN`,
                        organizationId: mockedParameters.ORGANIZATION_ID,
                        platformType: 'JIRA',
                    }),
                }),
            );

            expect(result).toEqual(mockedFunctions.getBoard().data);
        });

        it('should return an empty array if integration is not found', async () => {
            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(null);

            const params = {
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
                projectSelected: {
                    id: mockedParameters.PROJECT_ID,
                },
            };

            const result = await service.getBoard(params);

            expect(result).toEqual([]);
        });

        afterEach(() => {
            jest.clearAllMocks();
            jest.restoreAllMocks();
        });
    });
});

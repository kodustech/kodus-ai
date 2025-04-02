import { JiraService } from '@/core/infrastructure/adapters/services/jira/jira.service';
import { AxiosJiraService } from '@/config/axios/microservices/jira.axios';
import { JiraServiceTestUtils } from './testUtils';
import mockedFunctions from './mocks/functions';
import mockedParameters from './mocks/params';

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

    describe('getIssueTypes', () => {
        it('should return all issue types for a given project', async () => {
            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn<any, any>(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockResolvedValueOnce({
                boardId: '10',
                projectId: '10013',
                projectKey: 'QAS',
            });

            JiraServiceTestUtils.setupAxiosJiraService(
                mockedFunctions.getIssueTypes().data,
            );

            const result = await service.getIssueTypes({
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
            });

            expect(result).toEqual(mockedFunctions.getIssueTypes().data);
            expect(result.length).toBe(6);

            expect(result[0]).toHaveProperty('id');
            expect(result[0]).toHaveProperty('name');
            expect(result[0]).toHaveProperty('untranslatedName');
            expect(result[0]).toHaveProperty('description');

            expect(result).toEqual(mockedFunctions.getIssueTypes().data);
            expect(AxiosJiraService.prototype.get).toHaveBeenCalledWith(
                `https://api.atlassian.com/ex/jira/CLOUD_ID/rest/api/3/issuetype/project?projectId=10013`,
                {
                    headers: {
                        Authorization: 'Bearer AUTH_TOKEN',
                        organizationId: mockedParameters.ORGANIZATION_ID,
                        platformType: 'JIRA',
                    },
                },
            );
        });

        afterEach(() => {
            jest.clearAllMocks();
            jest.restoreAllMocks();
        });
    });
});

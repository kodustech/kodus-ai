import { JiraService } from '@/core/infrastructure/adapters/services/jira/jira.service';
import { AxiosJiraService } from '@/config/axios/microservices/jira.axios';
import { JiraServiceTestUtils } from './testUtils';
import mockedFunctions from './mocks/functions';
import mockedParameters from './mocks/params';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import jsonData from './mocks/jsonData';
import { PlatformIntegrationFactory } from '@/core/infrastructure/adapters/services/platformIntegration/platformIntegration.factory';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

describe('JiraService', () => {
    let service: JiraService;

    beforeAll(async () => {
        await JiraServiceTestUtils.setup();
        service = JiraServiceTestUtils.getService();

        // Register the JIRA service in the factory
        const platformIntegrationFactory = new PlatformIntegrationFactory();
        platformIntegrationFactory.registerProjectManagementService(
            'JIRA',
            service,
        );

        // Inject the mocked factory into the service
        service['projectManagementService']['platformIntegrationFactory'] =
            platformIntegrationFactory;
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        await JiraServiceTestUtils.clearDatabase();
        await JiraServiceTestUtils.setupTestData();
    });

    afterAll(async () => {
        await JiraServiceTestUtils.closeConnection();
    });

    describe('fetchIssuesFromAPI', () => {
        it('should construct the correct JQL query and call AxiosJiraService with the correct URL and headers', async () => {
            const mockIntegration = mockedParameters.INTEGRATION;

            const mockParams = {
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
                filters: {
                    workItemTypes: mockedParameters.WORK_ITEM_TYPES,
                },
            };
            const mockProjectId = mockedParameters.PROJECT_ID;
            const mockStartAt = 0;
            const mockMaxResults = 100;

            const mockResponse = {
                data: mockedFunctions.fetchAllIssues().data,
            };

            JiraServiceTestUtils.setupAxiosJiraService(mockResponse.data);

            const result = await service['fetchIssuesFromAPI'](
                mockIntegration,
                mockProjectId,
                mockParams,
                mockStartAt,
                mockMaxResults,
            );

            const expectedDateFilter = new Date(
                new Date().setDate(new Date().getDate() - 90),
            )
                .toISOString()
                .split('T')[0];

            const todayDate = new Date().toISOString().split('T')[0];

            expect(AxiosJiraService.prototype.get).toHaveBeenCalledWith(
                `https://api.atlassian.com/ex/jira/CLOUD_ID/rest/api/3/search?jql=project=10013%20AND%20issuetype%20IN%20("10000","10004","10018","10007","10012","10020")%20AND%20created%20>=%20"${expectedDateFilter}"%20AND%20created%20<=%20"${todayDate}"&fields=key,summary,description,status,issuetype,created,updated,lastViewed,assignee,priority,subtasks,project&expand=changelog&maxResults=100&startAt=0`,
                {
                    headers: {
                        Authorization: 'Bearer AUTH_TOKEN',
                        organizationId: mockedParameters.ORGANIZATION_ID,
                        platformType: 'JIRA',
                    },
                },
            );

            expect(result).toEqual(mockResponse);
        });
    });

    describe('fetchAllIssues', () => {
        it('should fetch all issues across multiple pages and return them as a single array', async () => {
            const integration = mockedParameters.INTEGRATION;
            const projectId = mockedParameters.PROJECT_ID;
            const params = {
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
                filters: {
                    workItemTypes: mockedParameters.WORK_ITEM_TYPES,
                },
            };

            const fetchIssuesFromAPI = jest
                .spyOn<any, any>(service as any, 'fetchIssuesFromAPI')
                .mockResolvedValueOnce({
                    data: {
                        issues: mockedFunctions.fetchAllIssues().data,
                        total: mockedFunctions.fetchAllIssues().data.length,
                    },
                });

            const result = await (service as any)['fetchAllIssues'](
                integration,
                projectId,
                params,
            );

            expect(fetchIssuesFromAPI).toHaveBeenCalledWith(
                integration,
                projectId,
                params,
                0,
                100,
            );

            expect(result[10]).toMatchObject({
                key: 'QAS-46',
                id: '10694',
                fields: {
                    summary: 'Média do Bimestre Calculada Incorretamente',
                    issuetype: { name: 'Critical Bug' },
                    created: '2024-08-12T14:10:07.542-0300',
                },
            });

            expect(result[20]).toMatchObject({
                key: 'QAS-36',
                id: '10684',
                fields: {
                    summary:
                        'Adicionar Recurso de Exportar Relatório para PDF, CSV e XLS',
                    issuetype: { name: 'Improvement' },
                    created: '2024-08-12T13:55:19.035-0300',
                },
            });

            expect(result[30]).toMatchObject({
                key: 'QAS-26',
                id: '10674',
                fields: {
                    summary: 'Geração Mensal de Mensalidades',
                    issuetype: { name: 'Story' },
                    created: '2024-08-12T13:44:17.273-0300',
                },
            });

            expect(result[40]).toMatchObject({
                key: 'QAS-16',
                id: '10664',
                fields: {
                    summary:
                        'Cadastro de Usuários - Múltiplos Usuários para o Mesmo Professor',
                    issuetype: { name: 'Critical Bug' },
                    created: '2024-08-12T13:25:59.814-0300',
                },
            });

            expect(result[50]).toMatchObject({
                key: 'QAS-6',
                id: '10654',
                fields: {
                    summary: 'Cadastro de usuários',
                    issuetype: { name: 'Story' },
                    created: '2024-08-12T11:23:35.606-0300',
                },
            });

            expect(result[0]).toHaveProperty('key');
            expect(result[0]).toHaveProperty('id');
            expect(result[0]).toHaveProperty('changelog');
            expect(result[0]).toHaveProperty('fields.summary');
            expect(result[0]).toHaveProperty('fields.issuetype.name');
            expect(result[0]).toHaveProperty('fields.created');
            expect(result[0]).toHaveProperty('fields.project');
            expect(result[0]).toHaveProperty('fields.project.id');
            expect(result[0]).toHaveProperty('fields.project.key');
            expect(result[0]).toHaveProperty('fields.project.name');
        });

        it('should return an empty array if no issues are fetched', async () => {
            const integration = mockedParameters.INTEGRATION;
            const projectId = mockedParameters.PROJECT_ID;
            const params = {
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
                filters: {
                    workItemTypes: mockedParameters.WORK_ITEM_TYPES,
                },
            };

            const fetchIssuesFromAPI = jest
                .spyOn<any, any>(service as any, 'fetchIssuesFromAPI')
                .mockResolvedValueOnce({
                    data: { issues: [] },
                });

            const result = await (service as any)['fetchAllIssues'](
                integration,
                projectId,
                params,
            );

            expect(result).toEqual([]);
        });

        afterEach(() => {
            jest.clearAllMocks();
            jest.restoreAllMocks();
        });
    });

    describe('getAllWorkItems', () => {
        it('should return all work items correctly', async () => {
            jest.spyOn(
                service['cacheService'],
                'getFromCache',
            ).mockResolvedValueOnce(null);

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockImplementation((key) => {
                if (
                    key === IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG
                ) {
                    return Promise.resolve({
                        boardId: '10',
                        projectId: '10013',
                        projectKey: 'QAS',
                    });
                } else if (key === IntegrationConfigKey.COLUMNS_MAPPING) {
                    return Promise.resolve(
                        mockedFunctions.getColumnsMapping().data,
                    );
                }
                return Promise.resolve(null);
            });

            jest.spyOn(service as any, 'fetchAllIssues').mockResolvedValueOnce(
                mockedFunctions.fetchAllIssues().data,
            );

            jest.spyOn(service, 'getIssueTypes').mockResolvedValue(
                mockedFunctions.getIssueTypes().data,
            );

            const result = await service.getAllWorkItems({
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
                filters: { workItemTypes: mockedParameters.WORK_ITEM_TYPES },
            });

            expect(result).toHaveLength(8);
            expect(result[0].workItems).toHaveLength(3);
            expect(result[1].workItems).toHaveLength(4);
            expect(result[2].workItems).toHaveLength(4);
            expect(result[3].workItems).toHaveLength(2);
            expect(result[4].workItems).toHaveLength(6);
            expect(result[5].workItems).toHaveLength(8);
            expect(result[6].workItems).toHaveLength(10);
            expect(result[7].workItems).toHaveLength(12);

            expect(result[0]).toHaveProperty('columnId');
            expect(result[0]).toHaveProperty('columnName');
            expect(result[0]).toHaveProperty('workItems');
            expect(result[0].workItems[0]).toHaveProperty('id');
            expect(result[0].workItems[0]).toHaveProperty('key');
            expect(result[0].workItems[0]).toHaveProperty('changelog');
            expect(result[0].workItems[0]).toHaveProperty('workItemType.id');
            expect(result[0].workItems[0]).toHaveProperty('workItemType.name');
            expect(result[0].workItems[0]).toHaveProperty('workItemCreatedAt');
            expect(result[0].workItems[0]).toHaveProperty('status.id');
            expect(result[0].workItems[0]).toHaveProperty('status.name');
            expect(result[0].workItems[0]).toHaveProperty(
                'status.statusCategory',
            );

            expect(service['cacheService'].getFromCache).toHaveBeenCalledWith(
                `jira_get_all_workitems_org_${mockedParameters.ORGANIZATION_AND_TEAM_DATA.organizationId}_team_${mockedParameters.ORGANIZATION_AND_TEAM_DATA.teamId}`,
            );

            expect(
                service['integrationConfigService']
                    .findIntegrationConfigFormatted,
            ).toHaveBeenNthCalledWith(
                1,
                'project_management_setup_config',
                mockedParameters.ORGANIZATION_AND_TEAM_DATA,
            );

            expect(
                service['integrationConfigService']
                    .findIntegrationConfigFormatted,
            ).toHaveBeenNthCalledWith(
                2,
                'columns_mapping',
                mockedParameters.ORGANIZATION_AND_TEAM_DATA,
            );
        });

        it('should return all work items to validate description correctly', async () => {
            jest.spyOn(
                service['cacheService'],
                'getFromCache',
            ).mockResolvedValueOnce(null);

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockImplementation((key) => {
                if (
                    key === IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG
                ) {
                    return Promise.resolve({
                        boardId: '10',
                        projectId: '10013',
                        projectKey: 'QAS',
                    });
                } else if (key === IntegrationConfigKey.COLUMNS_MAPPING) {
                    return Promise.resolve(
                        mockedFunctions.getColumnsMapping().data,
                    );
                }
                return Promise.resolve(null);
            });

            jest.spyOn(service as any, 'fetchAllIssues').mockResolvedValueOnce(
                mockedFunctions.fetchAllIssuesToValidateQualityDescription()
                    .data,
            );

            jest.spyOn(service, 'getIssueTypes').mockResolvedValue(
                mockedFunctions.getIssueTypesToValidateDescription().data,
            );

            const response = await service.getAllWorkItems({
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
                filters: {
                    workItemTypes:
                        mockedParameters.WORK_ITEM_TYPES_DESCRIPTION_QUALITY,
                },
            });

            const result = orderColumns(response);

            expect(result).toHaveLength(7);
            expect(result[0].workItems).toHaveLength(3);
            expect(result[1].workItems).toHaveLength(3);
            expect(result[2].workItems).toHaveLength(3);
            expect(result[3].workItems).toHaveLength(3);
            expect(result[4].workItems).toHaveLength(5);
            expect(result[5].workItems).toHaveLength(7);
            expect(result[6].workItems).toHaveLength(9);

            expect(result[0]).toHaveProperty('columnId');
            expect(result[0]).toHaveProperty('columnName');
            expect(result[0]).toHaveProperty('workItems');
            expect(result[0].workItems[0]).toHaveProperty('id');
            expect(result[0].workItems[0]).toHaveProperty('key');
            expect(result[0].workItems[0]).toHaveProperty('changelog');
            expect(result[0].workItems[0]).toHaveProperty('workItemType.id');
            expect(result[0].workItems[0]).toHaveProperty('workItemType.name');
            expect(result[0].workItems[0]).toHaveProperty('workItemCreatedAt');
            expect(result[0].workItems[0]).toHaveProperty('status.id');
            expect(result[0].workItems[0]).toHaveProperty('status.name');
            expect(result[0].workItems[0]).toHaveProperty(
                'status.statusCategory',
            );
        });

        it('should return all bug work items', async () => {
            jest.spyOn(
                service['cacheService'],
                'getFromCache',
            ).mockResolvedValueOnce(null);

            jest.spyOn<any, any>(
                service,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockedParameters.INTEGRATION);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockImplementation((key) => {
                if (
                    key === IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG
                ) {
                    return Promise.resolve({
                        boardId: '10',
                        projectId: '10013',
                        projectKey: 'QAS',
                    });
                } else if (key === IntegrationConfigKey.COLUMNS_MAPPING) {
                    return Promise.resolve(
                        mockedFunctions.getColumnsMapping().data,
                    );
                }
                return Promise.resolve(null);
            });

            jest.spyOn(service as any, 'fetchAllIssues').mockResolvedValueOnce(
                mockedFunctions.fetchAllIssuesAsBug().data,
            );

            jest.spyOn(service, 'getIssueTypes').mockResolvedValue(
                mockedFunctions.getIssueTypesAsBug().data,
            );

            const response = await service.getAllWorkItems({
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
                filters: {
                    workItemTypes: mockedParameters.WORK_ITEM_TYPES_BUGS,
                },
            });

            const result = orderColumns(response);

            expect(result).toHaveLength(7);
            expect(result[0].workItems).toHaveLength(1);
            expect(result[1].workItems).toHaveLength(2);
            expect(result[2].workItems).toHaveLength(1);
            expect(result[3].workItems).toHaveLength(3);
            expect(result[4].workItems).toHaveLength(3);
            expect(result[5].workItems).toHaveLength(3);
            expect(result[6].workItems).toHaveLength(3);

            expect(result[0]).toHaveProperty('columnId');
            expect(result[0]).toHaveProperty('columnName');
            expect(result[0]).toHaveProperty('workItems');
            expect(result[0].workItems[0]).toHaveProperty('id');
            expect(result[0].workItems[0]).toHaveProperty('key');
            expect(result[0].workItems[0]).toHaveProperty('changelog');
            expect(result[0].workItems[0]).toHaveProperty('workItemType.id');
            expect(result[0].workItems[0]).toHaveProperty('workItemType.name');
            expect(result[0].workItems[0]).toHaveProperty('workItemCreatedAt');
            expect(result[0].workItems[0]).toHaveProperty('status.id');
            expect(result[0].workItems[0]).toHaveProperty('status.name');
            expect(result[0].workItems[0]).toHaveProperty(
                'status.statusCategory',
            );
        });

        afterEach(() => {
            jest.clearAllMocks();
            jest.restoreAllMocks();
        });
    });

    describe('getEpicsAndLinkedItems', () => {
        it('should fetch epics and their linked items correctly', async () => {
            const params = {
                organizationAndTeamData:
                    mockedParameters.ORGANIZATION_AND_TEAM_DATA,
            };

            // Mock for PlatformIntegrationFactory
            jest.spyOn(
                service['projectManagementService'],
                'verifyConnection',
            ).mockResolvedValue({
                platformName: PlatformType.JIRA,
                isSetupComplete: true,
                hasConnection: true,
                config: {},
                category: IntegrationCategory.PROJECT_MANAGEMENT,
            });

            const mockIntegration = mockedParameters.INTEGRATION;
            const mockIntegrationConfig = {
                boardId: '10',
                projectId: '10013',
                projectKey: 'QAS',
            };

            jest.spyOn(
                service as any,
                'ensureAuthenticatedIntegration',
            ).mockResolvedValue(mockIntegration);

            jest.spyOn(
                service['integrationConfigService'],
                'findIntegrationConfigFormatted',
            ).mockResolvedValue(mockIntegrationConfig);

            jest.spyOn(service as any, 'buildBaseUrlAndHeader').mockReturnValue(
                {
                    url: 'https://api.atlassian.com/ex/jira/CLOUD_ID/rest/api/3/search?jql=project=10013 AND issuetype=Epic',
                    headers: {
                        Authorization: 'Bearer AUTH_TOKEN',
                        organizationId: mockedParameters.ORGANIZATION_ID,
                        platformType: 'JIRA',
                    },
                },
            );

            jest.spyOn(service['axiosClient'], 'get').mockResolvedValueOnce({
                data: { issues: jsonData.GET_ISSUES_TO_LINK_EPICS },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {} as any,
            });

            const getItemsLinkedToEpicMock = jest.spyOn(
                service,
                'getItemsLinkedToEpic' as keyof JiraService,
            );

            getItemsLinkedToEpicMock
                .mockResolvedValueOnce(jsonData.EPICS.EPIC_10649)
                .mockResolvedValueOnce(jsonData.EPICS.EPIC_10653)
                .mockResolvedValueOnce(jsonData.EPICS.EPIC_10662)
                .mockResolvedValueOnce(jsonData.EPICS.EPIC_10673)
                .mockResolvedValueOnce(jsonData.EPICS.EPIC_10677)
                .mockResolvedValueOnce(jsonData.EPICS.EPIC_10690)
                .mockResolvedValueOnce(jsonData.EPICS.EPIC_10698);

            const result = await service.getEpicsAndLinkedItems(params);

            expect(
                service['ensureAuthenticatedIntegration'],
            ).toHaveBeenCalledWith(params.organizationAndTeamData);
            expect(
                service['integrationConfigService']
                    .findIntegrationConfigFormatted,
            ).toHaveBeenCalledWith(
                IntegrationConfigKey.PROJECT_MANAGEMENT_SETUP_CONFIG,
                params.organizationAndTeamData,
            );
            expect(service['buildBaseUrlAndHeader']).toHaveBeenCalled();
            expect(service['axiosClient'].get).toHaveBeenCalledTimes(1);
            expect(service['getItemsLinkedToEpic']).toHaveBeenCalledTimes(7);

            expect(result).toBeInstanceOf(Array);
            expect(result).toHaveLength(7);
            result.forEach((epic) => {
                expect(epic).toHaveProperty('id');
                expect(epic).toHaveProperty('key');
                expect(epic).toHaveProperty('status');
                expect(epic).toHaveProperty('name');
                expect(epic).toHaveProperty('issues');
            });
        });
    });

    describe('getItemsLinkedToEpic', () => {
        const epicIds = [
            '10649',
            '10653',
            '10662',
            '10673',
            '10677',
            '10690',
            '10698',
        ];

        epicIds.forEach((epicId) => {
            it(`should fetch items linked to epic ${epicId} correctly`, async () => {
                const params = {
                    organizationAndTeamData:
                        mockedParameters.ORGANIZATION_AND_TEAM_DATA,
                    cloudId: 'CLOUD_ID',
                    projectId: '10013',
                    authToken: 'AUTH_TOKEN',
                    epicKey: epicId,
                };

                const mockWorkItemTypes = mockedParameters.WORK_ITEM_TYPES;

                jest.spyOn(
                    service['projectManagementService'],
                    'getWorkItemsTypes',
                ).mockResolvedValue(mockWorkItemTypes);

                jest.spyOn(
                    service as any,
                    'prepareWorkItemsTypesFilter',
                ).mockReturnValue(
                    'issuetype IN ("10000","10004","10018","10007","10012","10020")',
                );

                jest.spyOn(
                    service as any,
                    'buildBaseUrlAndHeader',
                ).mockReturnValue({
                    url: `https://api.atlassian.com/ex/jira/CLOUD_ID/rest/api/3/search?jql=project=10013 AND issuetype IN ("10000","10004","10018","10007","10012","10020") AND issuetype!=Epic AND "Epic Link"=${epicId}&fields=*all&expand=changelog&maxResults=100`,
                    headers: {
                        Authorization: 'Bearer AUTH_TOKEN',
                        organizationId: mockedParameters.ORGANIZATION_ID,
                        platformType: 'JIRA',
                    },
                });

                jest.spyOn(service['axiosClient'], 'get').mockResolvedValue({
                    data: { issues: jsonData.EPICS[`EPIC_${epicId}`] },
                    status: 200,
                    statusText: 'OK',
                    headers: {},
                    config: {
                        headers: undefined,
                    },
                });

                const result = await (service as any).getItemsLinkedToEpic(
                    params,
                );

                const expectedItems = jsonData.EPICS[`EPIC_${epicId}`].map(
                    (item) =>
                        expect.objectContaining({
                            id: item.id,
                            key: item.key,
                        }),
                );

                expect(result).toEqual(expect.arrayContaining(expectedItems));

                result.forEach((item) => {
                    expect(item).toHaveProperty('id');
                    expect(item).toHaveProperty('key');
                    expect(item).toHaveProperty('name');
                    expect(item).toHaveProperty('status');
                    expect(item).toHaveProperty('workItemType');
                });
            });
        });
    });
});

function orderColumns(data: any) {
    const order = [
        'selected for development',
        'in development',
        'ready for qa',
        'in qa',
        'ready for homologation',
        'in homologation',
        'ready for deploy',
        'done',
    ];

    const result = data.sort((a, b) => {
        const indexA = order.indexOf(a.columnName.toLowerCase());
        const indexB = order.indexOf(b.columnName.toLowerCase());

        return indexA - indexB;
    });

    return result;
}

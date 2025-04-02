import { JiraService } from '@/core/infrastructure/adapters/services/jira/jira.service';
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

    describe('transformIssuesToWorkItems', () => {
        it('should transform issues to work items correctly', async () => {
            const organizationAndTeamData =
                mockedParameters.ORGANIZATION_AND_TEAM_DATA;
            const integrationConfig = mockedParameters.INTEGRATION_CONFIG;
            const integration = mockedParameters.INTEGRATION;

            jest.spyOn(service, 'getIssueTypes').mockResolvedValue(
                mockedFunctions.getIssueTypes().data,
            );
            jest.spyOn(service as any, 'groupByColumn').mockReturnValue(
                mockedFunctions.groupByColumn().data,
            );

            const result = await (service as any)['transformIssuesToWorkItems'](
                organizationAndTeamData,
                mockedFunctions.fetchAllIssues().data,
                integrationConfig,
                integration,
            );

            expect(result).toBeInstanceOf(Object);
            expect(result[0]).toHaveProperty('columnName');
            expect(result[0]).toHaveProperty('columnId');
            expect(result[0]).toHaveProperty('workItems');
            expect(result[0].workItems[0]).toHaveProperty('id');
            expect(result[0].workItems[0]).toHaveProperty('key');
            expect(result[0].workItems[0]).toHaveProperty('name');
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
    });

    describe('groupByColumn', () => {
        it('should group cards by column correctly', () => {
            const result = (service as any)['groupByColumn'](jsonData.CARDS);

            expect(result).toEqual(mockedFunctions.groupByColumn().data);

            expect(result).toBeInstanceOf(Array);
            expect(result.length).toBeGreaterThan(0);

            result.forEach((column) => {
                expect(column).toHaveProperty('columnName');
                expect(column).toHaveProperty('columnId');
                expect(column).toHaveProperty('workItems');
                expect(column.workItems).toBeInstanceOf(Array);

                column.workItems.forEach((workItem) => {
                    expect(workItem).toHaveProperty('id');
                    expect(workItem).toHaveProperty('key');
                    expect(workItem).toHaveProperty('name');
                    expect(workItem).toHaveProperty('changelog');
                    expect(workItem).toHaveProperty('workItemCreatedAt');
                    expect(workItem).toHaveProperty('columnName');
                    expect(workItem).toHaveProperty('assignee');
                    expect(workItem).toHaveProperty('workItemType');
                    expect(workItem).toHaveProperty('status');
                    expect(workItem).toHaveProperty('priority');
                });
            });

            result.forEach((column) => {
                expect(
                    column.workItems.every(
                        (item) => item.columnName === column.columnName,
                    ),
                ).toBe(true);
            });

            result.forEach((column) => {
                column.workItems.forEach((workItem) => {
                    if (workItem.changelog) {
                        workItem.changelog.forEach((log) => {
                            expect(log).toHaveProperty('id');
                            expect(log).toHaveProperty('created');
                            expect(log).toHaveProperty('movements');
                            log.movements.forEach((movement) => {
                                expect(movement).toHaveProperty('field');
                                expect(movement).toHaveProperty('fromColumnId');
                                expect(movement).toHaveProperty(
                                    'fromColumnName',
                                );
                                expect(movement).toHaveProperty('toColumnId');
                                expect(movement).toHaveProperty('toColumnName');
                            });
                        });
                    }
                });
            });
        });
    });
});

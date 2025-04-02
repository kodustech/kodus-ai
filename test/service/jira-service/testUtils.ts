import { AxiosJiraService } from '@/config/axios/microservices/jira.axios';
import { JIRA_SERVICE_TOKEN } from '@/core/domain/jira/contracts/jira.service.contract';
import { JiraService } from '@/core/infrastructure/adapters/services/jira/jira.service';
import { JiraModule } from '@/modules/jira.module';
import { DatabaseModule } from '../../../src/modules/database.module';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

export class JiraServiceTestUtils {
    private static dataSource: DataSource;
    private static service: JiraService;
    private static moduleRef: TestingModule;

    static async setup() {
        if (!this.moduleRef) {
            this.moduleRef = await Test.createTestingModule({
                imports: [DatabaseModule, JiraModule],
            }).compile();

            this.service = this.moduleRef.get<JiraService>(JIRA_SERVICE_TOKEN);
            this.dataSource = this.moduleRef.get<DataSource>(DataSource);

            if (!this.dataSource.isInitialized) {
                await this.dataSource.initialize();
            }
        }
    }

    static setupAxiosJiraService(mockData) {
        AxiosJiraService.prototype.get = jest.fn().mockResolvedValue({
            data: mockData,
        });
    }

    static async clearDatabase() {
        if (this.dataSource && this.dataSource.isInitialized) {
            await this.dataSource.query(`
                DELETE FROM "public"."integrations" WHERE "organization_id" = '700ec9cc-da78-4772-8404-d2bda46d6277';
                DELETE FROM "public"."auth_integrations" WHERE "organization_id" = '700ec9cc-da78-4772-8404-d2bda46d6277';
                DELETE FROM "public"."teams" WHERE "uuid" = '9e4561d1-8374-4fa3-b384-637af67b2835';
                DELETE FROM "public"."organizations" WHERE "uuid" = '700ec9cc-da78-4772-8404-d2bda46d6277';
            `);
        }
    }

    static async setupTestData() {
        if (this.dataSource && this.dataSource.isInitialized) {
            await this.dataSource.query(`
            INSERT INTO "public"."organizations" ("name", "status", "tenantName", "uuid") VALUES
            ('Kody Copilot', true, 'KodyCopilot-700ec9cc-da78-4772-8404-d2bda46d6277', '700ec9cc-da78-4772-8404-d2bda46d6277');

            INSERT INTO "public"."teams" ("name", "status", "organization_id", "uuid") VALUES
            ('Kody Copilot Testinho', 'active', '700ec9cc-da78-4772-8404-d2bda46d6277', '9e4561d1-8374-4fa3-b384-637af67b2835');

            INSERT INTO "public"."auth_integrations" ("authDetails", "organization_id", "team_id","status", "uuid") VALUES
            ('{
                "baseUrl": "https://kodustech.atlassian.net",
                "cloudId": "30b864d3-bf6e-4baa-8f54-432280bb229c",
                "platform": "JIRA",
                "authToken": "AUTH_TOKEN",
                "expiresIn": 3600,
                "refreshToken": "REFRESH_TOKEN"
            }',
                '700ec9cc-da78-4772-8404-d2bda46d6277', '9e4561d1-8374-4fa3-b384-637af67b2835', true, 'f1cb67da-18f1-46c9-bec1-35273744714a'
            );

            INSERT INTO "public"."integrations" ("auth_integration_id", "integrationCategory", "organization_id", "team_id", "platform", "status", "uuid") VALUES
            ('f1cb67da-18f1-46c9-bec1-35273744714a', 'PROJECT_MANAGEMENT', '700ec9cc-da78-4772-8404-d2bda46d6277', '9e4561d1-8374-4fa3-b384-637af67b2835',  'JIRA', true, 'aea088af-98fe-4cdf-ad5a-d7616b81d9dc');
            `);
        }
    }

    static getService(): JiraService {
        return this.service;
    }

    static async closeConnection() {
        if (this.dataSource && this.dataSource.isInitialized) {
            try {
                await this.dataSource.destroy();
            } catch (error) {
                console.error('Error destroying DataSource:', error);
            }
        }
        if (this.moduleRef) {
            await this.moduleRef.close();
        }
    }
}

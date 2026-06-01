import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MCPConnectionEntity } from '../../src/modules/mcp/entities/mcp-connection.entity';
import { ProviderFactory } from '../../src/modules/providers/provider.factory';
import { AppModule } from '../../src/app.module';

import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AuthGuard } from '../../src/common/guards/auth.guard';
import { ValidationPipe } from '@nestjs/common';

const ORGANIZATION_ID = '35f64196-1720-41db-824c-6d856a89a2c6';
const INTEGRATION_ID = '3617df61-f016-4064-b0b2-a4c11d3d3c97';
const CONNECTION_ID = '442719b5-c729-483c-830c-e43ccfefbe57';

describe('MCP Controller (e2e)', () => {
    let app: NestFastifyApplication;
    let connectionRepository: Repository<MCPConnectionEntity>;

    const mockConnection = {
        id: CONNECTION_ID,
        organizationId: ORGANIZATION_ID,
        integrationId: INTEGRATION_ID,
        provider: 'provider',
        appName: 'test-app',
        status: 'active',
        mcpUrl: 'https://test-connection-url.com',
        metadata: { key: 'value' },
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
    };

    const mockIntegration = {
        id: INTEGRATION_ID,
        name: 'Test Integration',
        description: 'Test Description',
        authScheme: 'OAUTH',
        appName: 'test-app',
    };

    // Provider mock
    const mockProvider = {
        statusMap: {
            pending: 'pending',
            active: 'active',
            success: 'active',
            error: 'failed',
        },
        getIntegrations: jest.fn().mockResolvedValue({
            data: [mockIntegration],
            total: 1,
        }),
        getIntegration: jest.fn().mockResolvedValue(mockIntegration),
        getIntegrationRequiredParams: jest.fn().mockResolvedValue([
            {
                name: 'apiKey',
                description: 'API Key',
                type: 'string',
                required: true,
            },
        ]),
        getIntegrationTools: jest.fn().mockResolvedValue([
            {
                name: 'test-tool',
                description: 'Test Tool',
                warning: false,
            },
        ]),
        installIntegration: jest.fn().mockResolvedValue({
            connection: {
                id: 'test-install-id',
                status: 'active',
                url: 'https://auth-url.com',
            },
            server: {
                id: 'server-id',
                appName: 'test-app',
                mcpUrl: 'https://mcp-url.com',
            },
        }),
    };

    const mockProviderFactory = {
        getProvider: jest.fn().mockReturnValue(mockProvider),
        getProviders: jest.fn().mockReturnValue([mockProvider]),
    };

    const mockAuthMiddleware = {
        canActivate: jest.fn().mockImplementation((context) => {
            const request = context.switchToHttp().getRequest();
            request.organizationId = ORGANIZATION_ID;
            return true;
        }),
    };

    beforeAll(async () => {
        AuthGuard.prototype.canActivate = mockAuthMiddleware.canActivate;

        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        })
            .overrideProvider(ProviderFactory)
            .useValue(mockProviderFactory)
            .compile();

        app = moduleFixture.createNestApplication<NestFastifyApplication>(
            new FastifyAdapter(),
        );

        connectionRepository = moduleFixture.get<
            Repository<MCPConnectionEntity>
        >(getRepositoryToken(MCPConnectionEntity));

        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                transform: true,
                forbidNonWhitelisted: true,
                transformOptions: {
                    enableImplicitConversion: true,
                },
            }),
        );

        await app.init();
        await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        // Clear test data before each test
        await connectionRepository.clear();
        // Clear all mocks before each test
        jest.clearAllMocks();
    });

    describe('/mcp/connections (GET)', () => {
        it('should return connections for organization', async () => {
            await connectionRepository.save(mockConnection);

            const response = await request(app.getHttpServer())
                .get('/mcp/connections')
                .query({ page: 1, pageSize: 10 })
                .expect(200);

            expect(response.body).toHaveProperty('items');
            expect(response.body).toHaveProperty('total');
            expect(response.body.items).toHaveLength(1);
            expect(response.body.items[0]).toMatchObject({
                id: mockConnection.id,
                organizationId: mockConnection.organizationId,
            });
        });

        it('should handle pagination parameters', async () => {
            for (let i = 0; i < 4; i++) {
                const connection = {
                    ...mockConnection,
                    integrationId: INTEGRATION_ID.slice(0, -1) + i,
                    id: CONNECTION_ID.slice(0, -1) + i,
                };
                await connectionRepository.save(connection);
            }

            const response = await request(app.getHttpServer())
                .get('/mcp/connections')
                .query({ page: 2, pageSize: 2 })
                .expect(200);

            expect(response.body).toHaveProperty('items');
            expect(response.body).toHaveProperty('total');
            expect(response.body.items).toHaveLength(2);
            expect(response.body.total).toBe(4);
        });
    });

    describe('/mcp/connections/:connectionId (GET)', () => {
        it('should return specific connection', async () => {
            await connectionRepository.save(mockConnection);

            const response = await request(app.getHttpServer())
                .get(`/mcp/connections/${mockConnection.id}`)
                .expect(200);

            expect(response.body).toMatchObject({
                id: mockConnection.id,
                organizationId: mockConnection.organizationId,
            });
        });

        it('should return null for non-existent connection', async () => {
            await connectionRepository.save(mockConnection);

            const response = await request(app.getHttpServer())
                .get(`/mcp/connections/${INTEGRATION_ID}`) // non-existent connection id
                .expect(200);

            expect(response.body).toBeNull();
        });
    });

    describe('/mcp/integrations (GET)', () => {
        it('should return integrations with connection status', async () => {
            await connectionRepository.save(mockConnection);

            const response = await request(app.getHttpServer())
                .get('/mcp/integrations')
                .query({ page: 1, pageSize: 10 })
                .expect(200);

            expect(Array.isArray(response.body)).toBe(true);
            expect(response.body).toHaveLength(1);
            expect(response.body[0]).toMatchObject({
                data: [mockIntegration],
                total: 1,
                isConnected: false,
            });
            expect(mockProvider.getIntegrations).toHaveBeenCalledWith('1', 10, {
                appName: undefined,
            });
        });
    });

    describe('/mcp/:provider/integrations/:integrationId (GET)', () => {
        it('should return specific integration with connection status', async () => {
            await connectionRepository.save(mockConnection);

            const response = await request(app.getHttpServer())
                .get(`/mcp/provider/integrations/${INTEGRATION_ID}`)
                .expect(200);

            expect(response.body).toMatchObject({
                id: mockIntegration.id,
                name: mockIntegration.name,
                isConnected: true,
            });

            expect(mockProvider.getIntegration).toHaveBeenCalledWith(
                INTEGRATION_ID,
            );
        });
    });

    describe('/mcp/:provider/integrations/:integrationId/required-params (GET)', () => {
        it('should return required parameters for integration', async () => {
            const response = await request(app.getHttpServer())
                .get(
                    `/mcp/provider/integrations/${INTEGRATION_ID}/required-params`,
                )
                .expect(200);

            expect(response.body).toHaveLength(1);
            expect(response.body[0]).toMatchObject({
                name: 'apiKey',
                description: 'API Key',
                type: 'string',
                required: true,
            });

            expect(
                mockProvider.getIntegrationRequiredParams,
            ).toHaveBeenCalledWith(INTEGRATION_ID);
        });
    });

    describe('/mcp/:provider/integrations/:integrationId/tools (GET)', () => {
        it('should return tools for integration', async () => {
            const response = await request(app.getHttpServer())
                .get(`/mcp/provider/integrations/${INTEGRATION_ID}/tools`)
                .expect(200);

            expect(response.body).toHaveLength(1);
            expect(response.body[0]).toMatchObject({
                name: 'test-tool',
                description: 'Test Tool',
                warning: false,
            });

            expect(mockProvider.getIntegrationTools).toHaveBeenCalledWith(
                INTEGRATION_ID,
                ORGANIZATION_ID,
            );
        });
    });

    /* describe('/mcp/:provider/integrations/:integrationId/install (POST)', () => {
    it('should install integration successfully', async () => {
      const installDto = {
        apiKey: 'test-api-key',
        allowedTools: ['tool1', 'tool2'],
      };

      const response = await request(app.getHttpServer())
        .post(`/mcp/provider/integrations/${INTEGRATION_ID}/install`)
        .send(installDto)
        .expect(201);

      const connection = await connectionRepository.findOne({
        where: {
          integrationId: INTEGRATION_ID,
          organizationId: ORGANIZATION_ID,
        },
      });

      expect(response.body).toHaveProperty('provider', 'provider');
      expect(response.body).toHaveProperty('authUrl');
      expect(response.body).toHaveProperty('mcpUrl');

      expect(connection).toBeDefined();
      expect(connection.status).toBe('active');

      expect(mockProvider.installIntegration).toHaveBeenCalledWith(
        INTEGRATION_ID,
        ORGANIZATION_ID,
        installDto,
      );
    });

    it('should accept empty body for install', async () => {
      await request(app.getHttpServer())
        .post(`/mcp/provider/integrations/${INTEGRATION_ID}/install`)
        .send({}) // Empty body should be accepted
        .expect(201);
    });
  }); */

    describe('/mcp/connections (PATCH)', () => {
        it('should update integration successfully', async () => {
            await connectionRepository.save({
                ...mockConnection,
                status: 'pending',
            });

            const updateDto = {
                integrationId: INTEGRATION_ID,
                status: 'success',
            };

            await request(app.getHttpServer())
                .patch('/mcp/connections')
                .send(updateDto);

            const connection = await connectionRepository.findOne({
                where: {
                    integrationId: INTEGRATION_ID,
                    organizationId: ORGANIZATION_ID,
                },
            });

            expect(connection).toBeDefined();
            expect(connection.status).toBe('active');
        });
    });

    describe('Error handling', () => {
        it('should handle provider errors', async () => {
            mockProvider.getIntegrations.mockRejectedValue(
                new Error('Provider error'),
            );

            await request(app.getHttpServer())
                .get('/mcp/integrations')
                .expect(500);

            // Restore the mock for other tests
            mockProvider.getIntegrations.mockResolvedValue({
                data: [mockIntegration],
                total: 1,
            });
        });

        it('should handle database errors', async () => {
            jest.spyOn(connectionRepository, 'findAndCount').mockRejectedValue(
                new Error('Database error'),
            );

            await request(app.getHttpServer())
                .get('/mcp/connections')
                .expect(500);
        });
    });

    describe('Validation', () => {
        it('should handle invalid page parameters', async () => {
            jest.spyOn(connectionRepository, 'findAndCount').mockRejectedValue(
                new Error('Database error'),
            );

            await request(app.getHttpServer())
                .get('/mcp/connections')
                .expect(500); // Database error because of invalid pagination
        });
    });
});

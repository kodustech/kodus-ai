// The Kodus MCP an organization with a connected git host has, run in this
// process: production's MCP server (McpController → McpServerService →
// McpServerFactory, behind McpEnabledGuard and McpAuthGuard) with its tool
// classes and the services under them, and production's MCPManagerService
// handing an agent the org's connections. What is the eval's is the storage
// and the outside world:
//   - in-memory repositories in place of Postgres and Mongo (rules and
//     memories, issues, pull requests, teams, integrations, parameters);
//   - the mcp-manager's answer for the org: one Kodus MCP connection, the row
//     its createKodusMCPIntegration stores, with the tools its KodusMCPClient
//     lists;
//   - GitHub, as the REST answers of github-rest.js.
// A repository method production reaches and this file does not serve throws,
// so a run never passes on a store the eval made up.
//
// One stack serves a whole run; each case is its own organization, so the
// stores answer per organization as the databases do.
const crypto = require('crypto');
const http = require('http');
const path = require('path');

const lib = (p) => require(path.join(__dirname, '../../libs', p));

// A dependency production wires that no tool the eval runs reaches.
function unreached(name) {
    return new Proxy(
        {},
        {
            get: (_, key) => {
                if (key === 'then' || typeof key === 'symbol') return undefined;
                return () => {
                    throw new Error(`eval: ${name}.${String(key)} is not wired (evals/shared/kodus-mcp.js)`);
                };
            },
        },
    );
}

// A repository: the methods given, and a throw for any other.
function repository(name, methods) {
    return new Proxy(methods, {
        get: (target, key) => {
            if (key in target || key === 'then' || typeof key === 'symbol') return target[key];
            return () => {
                throw new Error(`eval: the in-memory ${name} does not serve ${String(key)} (evals/shared/kodus-mcp.js)`);
            };
        },
    });
}

// A row matches a filter as TypeORM's nested `where` and Mongo's dotted paths
// do: every given field equal, nested objects field by field.
const at = (row, key) => key.split('.').reduce((v, k) => (v == null ? v : v[k]), row);
function matches(row, filter) {
    return Object.entries(filter || {}).every(([key, want]) => {
        if (want === undefined) return true;
        const have = at(row, key);
        if (want && typeof want === 'object' && !Array.isArray(want) && !(want instanceof Date)) return have != null && matches(have, want);
        return have === want;
    });
}
const copy = (v) => structuredClone(v);

async function startKodusMcp() {
    const { mapSimpleModelToEntity, mapSimpleModelsToEntities } = lib('core/infrastructure/repositories/mappers.ts');
    const { KodyRulesEntity } = lib('kodyRules/domain/entities/kodyRules.entity.ts');
    const { IssuesEntity } = lib('issues/domain/entities/issues.entity.ts');
    const { PullRequestsEntity } = lib('platformData/domain/pullRequests/entities/pullRequests.entity.ts');
    const { ParametersEntity } = lib('organization/domain/parameters/entities/parameters.entity.ts');

    const db = { kodyRules: [], issues: [], pullRequests: [], teams: [], integrations: [], integrationConfigs: [], parameters: [], mcpConnections: [] };
    const doc = (data) => ({ _id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data });
    const entity = (row, Entity) => (row ? mapSimpleModelToEntity(copy(row), Entity) : null);

    const kodyRulesRepository = repository('kody rules repository', {
        findByOrganizationId: async (organizationId) => entity(db.kodyRules.find((d) => d.organizationId === organizationId), KodyRulesEntity),
        create: async (kodyRules) => {
            const saved = doc(copy(kodyRules));
            db.kodyRules.push(saved);
            return entity(saved, KodyRulesEntity);
        },
        findById: async (uuid, organizationId) => {
            const rule = db.kodyRules.find((d) => d.organizationId === organizationId)?.rules.find((r) => r.uuid === uuid);
            return rule ? copy(rule) : null;
        },
        addRule: async (uuid, rule) => {
            const saved = db.kodyRules.find((d) => d._id === uuid);
            if (!saved) return null;
            saved.rules.push(copy(rule));
            return entity(saved, KodyRulesEntity);
        },
        // Field by field, as kodyRules.repository.ts sets `rules.$.<field>`.
        updateRule: async (uuid, ruleId, patch) => {
            const saved = db.kodyRules.find((d) => d._id === uuid);
            const rule = saved?.rules.find((r) => r.uuid === ruleId);
            if (!rule) return null;
            for (const [key, value] of Object.entries(patch)) if (value !== undefined) rule[key] = copy(value);
            return entity(saved, KodyRulesEntity);
        },
    });

    const issuesRepository = repository('issues repository', {
        create: async (issue) => {
            const saved = doc(copy(issue));
            db.issues.push(saved);
            return entity(saved, IssuesEntity);
        },
        findById: async (uuid) => entity(db.issues.find((d) => d._id === uuid), IssuesEntity),
        findByFilters: async (filter) => mapSimpleModelsToEntities(db.issues.filter((d) => matches(d, filter)).map(copy), IssuesEntity),
        updateStatus: async (uuid, status) => {
            const saved = db.issues.find((d) => d._id === uuid);
            if (!saved) return null;
            saved.status = status;
            return entity(saved, IssuesEntity);
        },
        updateLabel: async (uuid, label) => {
            const saved = db.issues.find((d) => d._id === uuid);
            if (!saved) return null;
            saved.label = label;
            if (saved.representativeSuggestion) saved.representativeSuggestion.label = label;
            return entity(saved, IssuesEntity);
        },
    });

    const pullRequestsRepository = repository('pull requests repository', {
        findByNumberAndRepositoryId: async (number, repositoryId, organizationAndTeamData) =>
            entity(db.pullRequests.find((d) => d.number === number && d.repository?.id === repositoryId && d.organizationId === organizationAndTeamData.organizationId), PullRequestsEntity),
    });

    const rowOf = (rows) => async (filter) => (rows.find((r) => matches(r, filter)) ? copy(rows.find((r) => matches(r, filter))) : null);
    const teamRepository = repository('team repository', { findOne: rowOf(db.teams) });
    const integrationRepository = repository('integration repository', { findOne: rowOf(db.integrations) });
    const integrationConfigRepository = repository('integration config repository', {
        findOne: rowOf(db.integrationConfigs),
        findOneIntegrationConfigWithIntegrations: async (configKey, organizationAndTeamData) =>
            rowOf(db.integrationConfigs)({ configKey, integration: { organization: { uuid: organizationAndTeamData.organizationId } }, team: { uuid: organizationAndTeamData.teamId } }),
    });
    const parametersRepository = repository('parameters repository', {
        findByKey: async (configKey, organizationAndTeamData) =>
            entity(db.parameters.find((p) => p.configKey === configKey && p.team?.uuid === organizationAndTeamData.teamId && p.active), ParametersEntity),
        findOne: async (filter) => entity(db.parameters.filter((p) => matches(p, filter)).at(-1), ParametersEntity),
        // One active version per team and key, as the partial unique index keeps it.
        createNewActiveVersion: async (configKey, teamId, configValue, version) => {
            for (const p of db.parameters) if (p.configKey === configKey && p.team?.uuid === teamId) p.active = false;
            const saved = doc({ configKey, configValue: copy(configValue), team: { uuid: teamId }, active: true, version });
            db.parameters.push(saved);
            return entity(saved, ParametersEntity);
        },
    });

    const { ConfigService } = require('@nestjs/config');
    const { JwtService } = require('@nestjs/jwt');
    const { EventEmitter2 } = require('@nestjs/event-emitter');
    const { createCache } = require('cache-manager');
    const { evalPermissionService } = require('./org-route');
    if (!process.env.API_JWT_SECRET) process.env.API_JWT_SECRET = crypto.randomBytes(32).toString('hex');
    let controller;
    let guards;

    // The MCP server's HTTP endpoint, as Nest serves McpController: JSON body,
    // the controller's guards, an HttpException as Nest's filter answers it.
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.all('/mcp', async (req, res) => {
        try {
            const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
            for (const guard of guards) await guard.canActivate(context);
            if (req.method === 'POST') return await controller.handleClientRequest(req.body, res);
            if (req.method === 'GET') return await controller.handleServerNotifications(res);
            if (req.method === 'DELETE') return await controller.handleSessionTermination(res);
            res.status(404).end();
        } catch (error) {
            if (res.headersSent) return;
            const status = typeof error?.getStatus === 'function' ? error.getStatus() : 500;
            res.status(status).json(typeof error?.getResponse === 'function' ? error.getResponse() : { statusCode: 500, message: 'Internal server error' });
        }
    });
    const mcpServer = await listen(app);

    // The mcp-manager's answers: the org's connections (it reads the org off
    // the token kodus-ai signs) and, for a Kodus MCP connection, no extra
    // header (no managed credential or OAuth grant for it).
    const jwt = new JwtService();
    const managerServer = await listen(
        http.createServer((req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const send = (status, body) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            let organizationId;
            try {
                organizationId = jwt.verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), { secret: process.env.API_JWT_SECRET }).organizationId;
            } catch {
                return send(401, { message: 'Unauthorized' });
            }
            if (url.pathname === '/mcp/connections') {
                const items = db.mcpConnections.filter((c) => c.organizationId === organizationId && c.status === (url.searchParams.get('status') || 'ACTIVE'));
                return send(200, { items, total: items.length });
            }
            if (url.pathname.startsWith('/mcp/integration/kodusmcp/') && url.pathname.endsWith('/connection-config')) return send(200, { headers: {} });
            return send(404, { message: 'Not Found' });
        }),
    );

    // MCPManagerService reads where the manager and the MCP server are from
    // the environment, as production configures them.
    process.env.API_KODUS_SERVICE_MCP_MANAGER = `${managerServer.origin}/`;
    process.env.API_KODUS_MCP_SERVER_URL = `${mcpServer.origin}/mcp`;

    // Production's services over those stores; the servers above answer only
    // once these exist. The config is what production's config module gives
    // them: the MCP server on, the JWT secret, and no PostHog/Resend/n8n keys
    // (telemetry off).
    const configService = new ConfigService({ API_MCP_SERVER_ENABLED: true, jwtConfig: { secret: process.env.API_JWT_SECRET } });
    const { CacheService } = lib('core/cache/cache.service.ts');
    const cacheService = new CacheService(createCache());
    const { ParametersService } = lib('organization/infrastructure/adapters/services/parameters.service.ts');
    const { IntegrationConfigService } = lib('integrations/infrastructure/adapters/services/integrationConfig.service.ts');
    const { IntegrationService } = lib('integrations/infrastructure/adapters/services/integration.service.ts');
    const { TeamService } = lib('organization/infrastructure/adapters/services/team.service.ts');
    const { GithubService } = lib('platform/infrastructure/adapters/services/github/github.service.ts');
    const { PlatformIntegrationFactory } = lib('platform/infrastructure/adapters/services/platformIntegration.factory.ts');
    const { CodeManagementService } = lib('platform/infrastructure/adapters/services/codeManagement.service.ts');
    const { PlatformType } = lib('core/domain/enums/platform-type.enum.ts');
    const { KodyRulesValidationService } = lib('ee/kodyRules/service/kody-rules-validation.service.ts');
    const { KodyRulesService } = lib('ee/kodyRules/service/kodyRules.service.ts');
    const { CentralizedConfigPrService } = lib('centralized-config/infrastructure/adapters/services/centralized-config-pr.service.ts');
    const CodeBaseConfigService = lib('ee/codeBase/codeBaseConfig.service.ts').default;
    const { DeleteRuleInOrganizationByIdKodyRulesUseCase } = lib('kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case.ts');
    const { TelemetryService } = lib('telemetry/application/services/telemetry.service.ts');
    const { PostHogProvider } = lib('telemetry/infrastructure/providers/posthog.provider.ts');
    const { ResendEventsProvider } = lib('telemetry/infrastructure/providers/resend-events.provider.ts');
    const { N8nProvider } = lib('telemetry/infrastructure/providers/n8n.provider.ts');
    const { IssuesService } = lib('issues/infrastructure/adapters/service/issues.service.ts');
    const { PullRequestsService } = lib('platformData/infrastructure/adapters/services/pullRequests.service.ts');
    const { CodeManagementTools, KodyRulesTools, KodyIssuesTools } = lib('mcp-server/tools/index.ts');
    const { McpToolAuthorizer } = lib('mcp-server/auth/mcp-tool-authorizer.service.ts');
    const { McpServerFactory } = lib('mcp-server/services/mcp-server.factory.ts');
    const { McpServerService } = lib('mcp-server/services/mcp-server.service.ts');
    const { McpController } = lib('mcp-server/controllers/mcp.controller.ts');
    const { McpEnabledGuard } = lib('mcp-server/guards/mcp-enabled.guard.ts');
    const { McpAuthGuard } = lib('mcp-server/guards/mcp-auth.guard.ts');
    const { MCPManagerService, KODUS_MCP_INTEGRATION_ID } = lib('mcp-server/services/mcp-manager.service.ts');
    const { PARAMETERS_SERVICE_TOKEN } = lib('organization/domain/parameters/contracts/parameters.service.contract.ts');
    const { INTEGRATION_CONFIG_SERVICE_TOKEN } = lib('integrations/domain/integrationConfigs/contracts/integration-config.service.contracts.ts');

    const parametersService = new ParametersService(parametersRepository);
    const integrationConfigService = new IntegrationConfigService(integrationConfigRepository);
    const integrationService = new IntegrationService(integrationRepository, integrationConfigService);
    const teamService = new TeamService(teamRepository);
    const githubService = new GithubService(integrationService, unreached('authIntegrationService'), integrationConfigService, cacheService, configService);
    const platformIntegrationFactory = new PlatformIntegrationFactory();
    platformIntegrationFactory.registerCodeManagementService(PlatformType.GITHUB, githubService);
    const codeManagementService = new CodeManagementService(integrationService, platformIntegrationFactory);
    const permissionValidationService = evalPermissionService(null);
    const kodyRulesValidationService = new KodyRulesValidationService(permissionValidationService);
    const telemetry = new TelemetryService(new PostHogProvider(configService), new ResendEventsProvider(configService), new N8nProvider(configService));
    const mcpManagerService = new MCPManagerService(new JwtService(), permissionValidationService, telemetry);

    // Nest's container for the providers KodyRulesService and
    // CentralizedConfigPrService look up at run time.
    let centralizedConfigPrService;
    const provided = (token) => {
        const found = new Map([
            [CentralizedConfigPrService, () => centralizedConfigPrService],
            [PARAMETERS_SERVICE_TOKEN, () => parametersService],
            [INTEGRATION_CONFIG_SERVICE_TOKEN, () => integrationConfigService],
        ]).get(token);
        if (!found) throw new Error(`eval: no provider ${String(token?.name || token)} in the eval's container`);
        return found();
    };
    const moduleRef = { get: provided, resolve: async (token) => provided(token) };
    let codeBaseConfigService;
    // KodyRuleSummaryService is optional in production (@Optional) and only
    // summarizes long rules in the background after a write: left out.
    const kodyRulesService = new KodyRulesService(
        kodyRulesRepository,
        new EventEmitter2(),
        unreached('ruleLikeService'),
        unreached('pullRequestsRepository'),
        kodyRulesValidationService,
        mcpManagerService,
        unreached('observabilityService'),
        permissionValidationService,
        moduleRef,
        new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : (...a) => codeBaseConfigService[key](...a)) }),
    );
    centralizedConfigPrService = new CentralizedConfigPrService(parametersService, integrationConfigService, kodyRulesService, moduleRef, codeManagementService);
    codeBaseConfigService = new CodeBaseConfigService(
        integrationService,
        integrationConfigService,
        unreached('organizationParametersService'),
        parametersService,
        kodyRulesService,
        unreached('globalParametersService'),
        codeManagementService,
        kodyRulesValidationService,
        permissionValidationService,
        cacheService,
    );
    const deleteRule = new DeleteRuleInOrganizationByIdKodyRulesUseCase(kodyRulesService, centralizedConfigPrService, unreached('authorizationService'), telemetry, teamService);

    const factory = new McpServerFactory(
        new CodeManagementTools(codeManagementService),
        new KodyRulesTools(kodyRulesService, centralizedConfigPrService, deleteRule),
        new KodyIssuesTools(new IssuesService(issuesRepository), new PullRequestsService(pullRequestsRepository, codeManagementService)),
        new McpToolAuthorizer(teamService),
    );
    controller = new McpController(new McpServerService(factory));
    guards = [new McpEnabledGuard(configService), new McpAuthGuard(new JwtService(), configService, unreached('teamCliKeyService'))];

    const { KodusMCPClient } = require(path.join(__dirname, '../../apps/mcp-manager/src/clients/kodusMCP/index.ts'));
    const managedServers = require(path.join(__dirname, '../../apps/mcp-manager/src/config/managed-mcp-servers.json'));

    /**
     * An organization with a GitHub integration (a token on a GitHub host),
     * the repository selected, its team's language, the pull request as Kodus
     * stored it after the review, and the Kodus MCP connection the mcp-manager
     * creates for it.
     */
    function addOrganization({ organizationAndTeamData, language, github, repository, pullRequest }) {
        const { organizationId, teamId } = organizationAndTeamData;
        const { encrypt } = lib('common/utils/crypto.ts');
        const integrationId = crypto.randomUUID();
        db.teams.push({ uuid: teamId, name: 'eval', organization: { uuid: organizationId } });
        db.integrations.push({
            uuid: integrationId,
            platform: PlatformType.GITHUB,
            integrationCategory: 'CODE_MANAGEMENT',
            status: true,
            organization: { uuid: organizationId },
            team: { uuid: teamId },
            authIntegration: { uuid: crypto.randomUUID(), status: true, authDetails: { authMode: 'token', authToken: encrypt('eval-token'), org: github.owner, host: github.host, accountType: 'organization' } },
        });
        db.integrationConfigs.push({
            uuid: crypto.randomUUID(),
            configKey: 'repositories',
            configValue: [{ id: repository.id, name: repository.name, full_name: repository.fullName, organizationName: github.owner, default_branch: 'main', http_url: `${github.host}/${repository.fullName}`, visibility: 'private', selected: true, language: 'TypeScript' }],
            integration: { uuid: integrationId, organization: { uuid: organizationId } },
            team: { uuid: teamId },
        });
        db.parameters.push(doc({ configKey: 'language_config', configValue: language, team: { uuid: teamId }, active: true, version: 1 }));
        db.pullRequests.push(doc({ organizationId, ...copy(pullRequest) }));
        const tools = new KodusMCPClient().getTools();
        db.mcpConnections.push({
            id: crypto.randomUUID(),
            organizationId,
            integrationId: KODUS_MCP_INTEGRATION_ID,
            provider: 'kodusmcp',
            status: 'ACTIVE',
            appName: new KodusMCPClient().getIntegration().appName,
            mcpUrl: process.env.API_KODUS_MCP_SERVER_URL,
            allowedTools: tools.map((tool) => tool.slug),
            metadata: { description: 'kodusmcp integration for organization', autoCreated: true },
            category: managedServers.find((s) => s.id === KODUS_MCP_INTEGRATION_ID)?.category ?? null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deletedAt: null,
        });
    }

    // What the org's stores hold that the agent wrote: rules and memories,
    // and issues.
    function writtenBy(organizationId) {
        return {
            rules: (db.kodyRules.find((d) => d.organizationId === organizationId)?.rules || []).map((r) => ({ type: r.type, title: r.title, status: r.status })),
            issues: db.issues.filter((i) => i.organizationId === organizationId).map((i) => ({ title: i.title, status: i.status })),
        };
    }

    return {
        mcpManagerService,
        parametersService,
        permissionValidationService,
        addOrganization,
        writtenBy,
        close: async () => {
            await mcpServer.close();
            await managerServer.close();
        },
    };
}

function listen(handler) {
    const server = handler instanceof http.Server ? handler : http.createServer(handler);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () =>
            resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))) }),
        );
    });
}

module.exports = { startKodusMcp };

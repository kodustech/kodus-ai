// Production's business-logic stage, run from data.
//
// BusinessLogicValidationStage runs BusinessRulesValidationAgentProvider, which
// reaches its tools through production's MCPManagerService and MCP adapter,
// over HTTP, as in a deployment. What answers on the other end:
//   - the Kodus MCP server is production's own (McpAuthGuard, McpController,
//     McpServerService, McpServerFactory, CodeManagementTools), its code host
//     answering from the case's PR;
//   - the mcp-manager service, which lists the organization's connections, is
//     the eval's: it answers with the two connections a team with Jira linked
//     has (Kodus MCP and Atlassian);
//   - the Atlassian MCP is the eval's: getAccessibleAtlassianResources and
//     getJiraIssue answer from the case's ticket, in Atlassian's shape.
// Everything else is production's: the skill (SKILL.md), the fetch steps, the
// task-quality gate, the analyzer and its parser, the stage's classification
// and the comment it publishes.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { registerTs } = require('../shared/eval-kit');

registerTs();
const lib = (p) => require(path.join(__dirname, '../../libs', p));

const ORG = { organizationId: '00000000-0000-4000-8000-0000000b1001', teamId: '00000000-0000-4000-8000-0000000b1002' };
const REPOSITORY = { id: 'eval-business-logic-repo', name: 'shop-api', fullName: 'acme/shop-api' };
const ATLASSIAN_SITE = { id: '6f1b0c2e-0000-4000-8000-0000000b1003', url: 'https://acme.atlassian.net', name: 'acme' };
const KODUS_MCP_INTEGRATION_ID = 'kd_mcp_oTUrzqsaxTg';

// A unified diff as the code host lists a PR's files.
function filesOfDiff(diff) {
    const files = [];
    for (const part of String(diff).split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '))) {
        const name = (part.match(/^\+\+\+ b\/(.+)$/m) || part.match(/^diff --git a\/\S+ b\/(\S+)/))[1];
        const at = part.indexOf('\n@@');
        const patch = at >= 0 ? part.slice(at + 1).replace(/\n+$/, '') : '';
        const lines = patch.split('\n');
        files.push({
            filename: name,
            status: 'modified',
            additions: lines.filter((l) => l.startsWith('+')).length,
            deletions: lines.filter((l) => l.startsWith('-')).length,
            changes: lines.filter((l) => /^[+-]/.test(l)).length,
            patch,
        });
    }
    return files;
}

// The PR as GitHub's adapter returns it (getPullRequest).
function pullRequestRecord(pr) {
    const repo = { id: REPOSITORY.id, name: REPOSITORY.name, defaultBranch: 'main', fullName: REPOSITORY.fullName };
    const at = '2026-10-01T12:00:00Z';
    return {
        id: String(pr.number), number: pr.number, pull_number: pr.number, body: pr.body, title: pr.title, message: pr.title,
        state: 'open', organizationId: ORG.organizationId, repository: REPOSITORY.name, repositoryId: REPOSITORY.id,
        repositoryData: { id: REPOSITORY.id, name: REPOSITORY.name }, prURL: `https://github.com/${REPOSITORY.fullName}/pull/${pr.number}`,
        created_at: at, closed_at: '', updated_at: at, merged_at: '', participants: [], reviewers: [],
        sourceRefName: pr.headRef, head: { ref: pr.headRef, repo }, targetRefName: 'main', base: { ref: 'main', repo },
        user: { login: 'dev', name: 'dev', id: '1' },
    };
}

// The ticket as Atlassian's getJiraIssue returns it, from a `# Task: <title>`
// markdown file.
function jiraIssue(key, markdown) {
    const [first, ...rest] = String(markdown).split('\n');
    return { key, fields: { summary: first.replace(/^#\s*(Task:\s*)?/, '').trim(), description: rest.join('\n').trim(), status: { name: 'In Progress' }, issuetype: { name: 'Story' } } };
}

// One local HTTP server: production's Kodus MCP at /mcp, and the eval's
// mcp-manager and Atlassian MCP beside it. `world.current` is the case under
// review; reviews run one at a time.
async function startServices(world) {
    const express = require('express');
    const { JwtService } = require('@nestjs/jwt');
    const { z } = require('zod');
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { McpAuthGuard } = lib('mcp-server/guards/mcp-auth.guard.ts');
    const { McpController } = lib('mcp-server/controllers/mcp.controller.ts');
    const { McpServerService } = lib('mcp-server/services/mcp-server.service.ts');
    const { McpServerFactory } = lib('mcp-server/services/mcp-server.factory.ts');
    const { McpToolAuthorizer } = lib('mcp-server/auth/mcp-tool-authorizer.service.ts');
    const { CodeManagementTools, KodyRulesTools, KodyIssuesTools } = lib('mcp-server/tools/index.ts');

    process.env.API_JWT_SECRET = crypto.randomBytes(32).toString('hex');
    const secret = process.env.API_JWT_SECRET;

    // What the code host answers about the case's PR.
    const codeHost = {
        getPullRequest: async ({ prNumber }) => (world.current?.pr.number === prNumber ? pullRequestRecord(world.current.pr) : null),
        getFilesByPullRequestId: async ({ prNumber }) => (world.current?.pr.number === prNumber ? filesOfDiff(world.current.diff) : []),
        getRepositories: async () => [{ id: REPOSITORY.id, name: REPOSITORY.name, fullName: REPOSITORY.fullName }],
    };
    // The organization's teams, which the tool authorizer checks a call against.
    const teams = { findOneOrganizationIdByTeamId: async (teamId) => (teamId === ORG.teamId ? ORG.organizationId : null) };
    const factory = new McpServerFactory(
        new CodeManagementTools(codeHost),
        // Registered beside it in production; this skill calls none of them.
        new KodyRulesTools(undefined, undefined, undefined),
        new KodyIssuesTools(undefined, undefined),
        new McpToolAuthorizer(teams),
    );
    const controller = new McpController(new McpServerService(factory));
    const guard = new McpAuthGuard(new JwtService(), { get: (k) => (k === 'jwtConfig' ? { secret } : undefined) }, { validateKey: async () => null });

    const app = express();
    app.use(express.json({ limit: '5mb' }));

    // Production's Kodus MCP, behind its own guard.
    app.post('/mcp', async (req, res) => {
        try {
            await guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) });
        } catch (error) {
            res.status(401).json({ message: String(error.message || error) });
            return;
        }
        await controller.handleClientRequest(req.body, res);
    });
    app.get('/mcp', (req, res) => controller.handleServerNotifications(res));

    // The mcp-manager service: the organization's active connections.
    const managerBase = (req) => `http://127.0.0.1:${req.socket.localPort}`;
    app.get('/mcp/connections', (req, res) => {
        const base = managerBase(req);
        const at = '2026-10-01T12:00:00Z';
        const item = (id, integrationId, appName, mcpUrl, allowedTools, category) => ({
            id, organizationId: ORG.organizationId, integrationId, provider: 'kodusmcp', status: 'ACTIVE', appName, mcpUrl, allowedTools,
            metadata: { connection: { id, mcpUrl, status: 'ACTIVE', appName, authUrl: '', allowedTools } }, category, createdAt: at, updatedAt: at, deletedAt: null,
        });
        res.json({
            items: [
                item('conn-kodus', KODUS_MCP_INTEGRATION_ID, 'Kodus MCP', `${base}/mcp`, ['KODUS_GET_PULL_REQUEST', 'KODUS_GET_PULL_REQUEST_DIFF'], null),
                item('conn-atlassian', 'atlassian', 'Atlassian', `${base}/atlassian`, ['getAccessibleAtlassianResources', 'getJiraIssue'], 'task-management'),
            ],
        });
    });
    app.get('/mcp/integrations', (req, res) => res.json([]));
    app.get('/mcp/integration/kodusmcp/:id/connection-config', (req, res) => res.json({ headers: {} }));

    // Atlassian's MCP, answering from the case's ticket.
    app.post('/atlassian', async (req, res) => {
        const server = new McpServer({ name: 'atlassian', version: '1.0.0' }, { capabilities: { tools: {} } });
        const text = (value, isError) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
        server.registerTool('getAccessibleAtlassianResources', { description: 'List the Atlassian sites (cloudId and url) this connection can access.', inputSchema: {} }, async () =>
            text([{ ...ATLASSIAN_SITE, scopes: ['read:jira-work'] }]));
        server.registerTool(
            'getJiraIssue',
            {
                description: 'Get a Jira issue by its id or key.',
                inputSchema: { cloudId: z.string().describe('Atlassian site id (UUID) or site URL'), issueIdOrKey: z.string().describe('Issue id or key, e.g. PROJ-123') },
            },
            async ({ cloudId, issueIdOrKey }) => {
                const ticket = world.current?.ticket;
                const known = ticket && ticket.task && String(issueIdOrKey).toUpperCase() === ticket.key && [ATLASSIAN_SITE.id, ATLASSIAN_SITE.url].includes(String(cloudId).replace(/\/+$/, ''));
                return known ? text(jiraIssue(ticket.key, ticket.task)) : text('Issue does not exist or you do not have permission to see it.', true);
            },
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        // Each close on its own: a failing one neither escapes nor skips the other.
        res.on('close', () => {
            Promise.resolve().then(() => transport.close()).catch((error) => console.warn('fake Atlassian MCP: transport close failed:', error instanceof Error ? error.message : 'Unknown cleanup error'));
            Promise.resolve().then(() => server.close()).catch((error) => console.warn('fake Atlassian MCP: server close failed:', error instanceof Error ? error.message : 'Unknown cleanup error'));
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.API_KODUS_SERVICE_MCP_MANAGER = `${base}/`;
    process.env.API_KODUS_MCP_SERVER_URL = `${base}/mcp`;
    return { close: () => new Promise((resolve) => server.close(resolve)) };
}

// One ObservabilityService for the process, as production's module has: it
// registers itself as the LLM port when built.
let sharedObservability;
function observability() {
    if (!sharedObservability) {
        const { ObservabilityService } = lib('core/log/observability.service.ts');
        sharedObservability = new ObservabilityService({ get: () => undefined });
    }
    return sharedObservability;
}

// The stage with its production collaborators. `verifyAnalyzerResult` is the
// one skill-policy setting a deployment can change (off by default).
function buildStage({ verifyAnalyzerResult = false, storedConfig = null } = {}) {
    const { JwtService } = require('@nestjs/jwt');
    const { BusinessLogicValidationStage } = lib('code-review/pipeline/stages/business-logic-validation.stage.ts');
    const { BusinessRulesValidationAgentProvider } = lib('agents/infrastructure/services/agents/business-rules-validation/businessRulesValidationAgent.ts');
    const { GenericSkillRunnerService } = lib('agents/skills/generic-skill-runner.service.ts');
    const { SkillLoaderService } = lib('agents/skills/skill-loader.service.ts');
    const { CapabilityStrategyService } = lib('agents/skills/runtime/capability-strategy.service.ts');
    const { CapabilityResourcePlanService } = lib('agents/skills/runtime/capability-resource-plan.service.ts');
    const { MCPManagerService } = lib('mcp-server/services/mcp-manager.service.ts');
    const { ParametersService } = lib('organization/infrastructure/adapters/services/parameters.service.ts');

    // The org's stored model config (evals/shared/model-route.js): none on the
    // managed default, a BYOK config for any other model.
    const permission = require('../shared/model-route').evalPermissionService(storedConfig);
    const mcpManager = new MCPManagerService(new JwtService(), permission, undefined);
    const skillRunner = new GenericSkillRunnerService(new SkillLoaderService(), observability(), mcpManager);
    if (verifyAnalyzerResult) {
        const policy = skillRunner.getExecutionPolicy.bind(skillRunner);
        skillRunner.getExecutionPolicy = (name) => ({ ...policy(name), verifyAnalyzerResult: true });
    }
    // The team's language setting, as stored.
    const parameters = new ParametersService({ findByKey: async () => ({ configValue: 'en-US' }) });
    const provider = new BusinessRulesValidationAgentProvider(
        permission,
        parameters,
        observability(),
        skillRunner,
        undefined,
        new CapabilityStrategyService(),
        new CapabilityResourcePlanService(),
    );
    return new BusinessLogicValidationStage(provider, mcpManager);
}

// One case through the stage: what it publishes and the outcome it records.
async function reviewCase(world, c, opts) {
    const dir = path.join(__dirname, 'files');
    world.current = {
        pr: c.pr,
        diff: fs.readFileSync(path.join(dir, c.diff), 'utf8'),
        ticket: { key: c.ticket.key, task: c.ticket.task ? fs.readFileSync(path.join(dir, c.ticket.task), 'utf8') : null },
    };
    const stage = buildStage(opts);
    const context = {
        organizationAndTeamData: ORG,
        platformType: 'GITHUB',
        repository: REPOSITORY,
        pullRequest: { number: c.pr.number, title: c.pr.title, body: c.pr.body, head: { ref: c.pr.headRef }, base: { ref: 'main' } },
        codeReviewConfig: { reviewOptions: { business_logic: true } },
        pipelineMetadata: {},
        statusInfo: {},
        errors: [],
    };
    try {
        const out = await stage.execute(context);
        return { outcome: out.businessLogicOutcome || null, published: out.businessLogicResults || [], errors: out.errors || [] };
    } finally {
        world.current = null;
    }
}

module.exports = { startServices, reviewCase, observability, filesOfDiff, ORG };

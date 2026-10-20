// Production's business-logic stage, run from data.
//
// BusinessLogicValidationStage runs BusinessValidationService, which reads the
// task through production's MCPManagerService and MCP adapter, over HTTP, as
// in a deployment, and BusinessLogicPublisher, which writes the PR comment.
// What answers on the other end:
//   - the mcp-manager service, which lists the organization's connections, is
//     the eval's: it answers with the two connections a team with Jira linked
//     has, Kodus MCP (production's own server, which reads no task) and
//     Atlassian Rovo (the managed `atlassian-rovo-default`);
//   - the Atlassian MCP is the eval's: getAccessibleAtlassianResources,
//     getJiraIssue and getVisibleJiraProjects answer from the case's ticket,
//     in Atlassian's shape;
//   - the code host is the eval's: it answers from the case's PR and keeps
//     the comments the publisher writes;
//   - the validation runs are kept in memory, none before the case.
// Everything else is production's: the reference finder, the Jira tracker,
// the task-quality gate, the judge (SKILL.md) and its gap check, the verdict,
// the stage's outcome and the comment it renders.
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
// markdown file, with its parent and sub-tasks when it has them.
function jiraIssue(key, markdown, { parent, subtasks } = {}) {
    const [first, ...rest] = String(markdown).split('\n');
    return {
        key,
        fields: {
            summary: first.replace(/^#\s*(Task:\s*)?/, '').trim(),
            description: rest.join('\n').trim(),
            status: { name: 'In Progress' },
            issuetype: { name: parent ? 'Sub-task' : 'Story' },
            ...(parent ? { parent: { key: parent } } : {}),
            ...(subtasks?.length
                ? { subtasks: subtasks.map((t) => ({ key: t.key, fields: { summary: t.title, status: { name: t.status || 'To Do' } } })) }
                : {}),
        },
    };
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
                item('conn-atlassian', 'atlassian-rovo-default', 'Atlassian', `${base}/atlassian`, ['getAccessibleAtlassianResources', 'getJiraIssue', 'getVisibleJiraProjects'], 'task-management'),
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
                const ticket = (world.current?.tickets || []).find((t) => t.key === String(issueIdOrKey).toUpperCase());
                const known = ticket && ticket.task && [ATLASSIAN_SITE.id, ATLASSIAN_SITE.url].includes(String(cloudId).replace(/\/+$/, ''));
                return known ? text(jiraIssue(ticket.key, ticket.task, ticket)) : text('Issue does not exist or you do not have permission to see it.', true);
            },
        );
        server.registerTool(
            'getVisibleJiraProjects',
            { description: 'List the Jira projects visible on a site.', inputSchema: { cloudId: z.string().describe('Atlassian site id (UUID) or site URL') } },
            async () => text({ values: [{ key: 'PROJ', name: 'Project' }] }),
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

// The stage with its production collaborators. `codeHost` keeps the comments
// the publisher writes. `verifyAnalyzerResult` is the one skill-policy setting
// a deployment can change (SKILL.md, off by default).
function buildStage({ verifyAnalyzerResult = false, storedConfig = null, codeHost, judgeFailures = [], outcomes = [] }) {
    const { JwtService } = require('@nestjs/jwt');
    const { BusinessLogicValidationStage } = lib('code-review/pipeline/stages/business-logic-validation.stage.ts');
    const { BusinessValidationService } = lib('agents/business-validation/business-validation.service.ts');
    const { BusinessLogicPublisher } = lib('platform/application/services/business-logic-publisher.service.ts');
    const { SkillLoaderService } = lib('agents/skills/skill-loader.service.ts');
    const { MCPManagerService } = lib('mcp-server/services/mcp-manager.service.ts');
    const { ParametersService } = lib('organization/infrastructure/adapters/services/parameters.service.ts');

    // The org's stored model config (evals/shared/model-route.js): none on the
    // managed default, a BYOK config for any other model.
    const permission = require('../shared/model-route').evalPermissionService(storedConfig);
    const mcpManager = new MCPManagerService(new JwtService(), permission, undefined);
    // The team's language setting, as stored.
    const parameters = new ParametersService({ findByKey: async () => ({ configValue: 'en-US' }) });
    const skills = new SkillLoaderService();
    if (verifyAnalyzerResult) {
        const meta = skills.loadSkillMetaFromFilesystem.bind(skills);
        skills.loadSkillMetaFromFilesystem = (name) => {
            const m = meta(name) ?? {};
            return { ...m, executionPolicy: { ...m.executionPolicy, verifyAnalyzerResult: true } };
        };
    }
    const service = new BusinessValidationService(mcpManager, permission, parameters, skills);
    // A task the judge could not answer: the run records only `judge_failed`,
    // its reason and cause go to this warning (analyzer_failure: the call
    // failed, a key, a quota or a timeout; parser_fallback: the answer).
    const warn = service.logger.warn.bind(service.logger);
    service.logger.warn = (entry) => {
        const reason = String(entry?.message || '').match(/Could not judge \S+ \((\w+)\)/)?.[1];
        if (reason) judgeFailures.push({ reason, cause: entry.metadata?.cause });
        return warn(entry);
    };
    // No run of this PR before the case.
    const runs = {
        forPullRequest: async () => [],
        latestForPullRequest: async () => undefined,
        create: async () => 'eval-run',
        clearPendingRecheck: async () => undefined,
    };
    const publisher = new BusinessLogicPublisher(service, codeHost, runs);
    // What the service decided, as the publisher receives it.
    const publish = publisher.publish.bind(publisher);
    publisher.publish = (input) => {
        outcomes.push(input.result.outcome);
        return publish(input);
    };
    return new BusinessLogicValidationStage(service, publisher);
}

// The code host the publisher and the gap check talk to: the case's PR, no
// other file in the repository, and the comments written on it.
function caseCodeHost(world, comments) {
    return {
        getPullRequest: async () => pullRequestRecord(world.current.pr),
        getAllCommentsInPullRequest: async () => comments.map((body, i) => ({ id: i + 1, body })),
        createIssueComment: async ({ body }) => {
            comments.push(body);
            return { id: comments.length };
        },
        updateIssueComment: async ({ body, commentId }) => {
            comments[Number(commentId) - 1] = body;
        },
        // The repository at the PR's head: the files the diff touches and the
        // ones the case says were already there.
        getRepositoryAllFiles: async () => [
            ...new Set([...filesOfDiff(world.current.diff).map((f) => f.filename), ...Object.keys(world.current.repoFiles)]),
        ].map((p) => ({ path: p })),
        getRepositoryContentFile: async ({ file }) =>
            file?.filename in world.current.repoFiles ? { data: { content: world.current.repoFiles[file.filename] } } : null,
    };
}

// One case through the stage: the comments it publishes and the outcome it
// records.
async function reviewCase(world, c, opts = {}) {
    const dir = opts.filesDir || path.join(__dirname, 'files');
    world.current = {
        pr: c.pr,
        diff: fs.readFileSync(path.join(dir, c.diff), 'utf8'),

        // The ticket the PR closes, and the ones it links to (parent, sub-tasks).
        tickets: [c.ticket, ...(c.related || [])].map((t) => ({
            ...t,
            task: t.task ? fs.readFileSync(path.join(dir, t.task), 'utf8') : null,
        })),
        repoFiles: Object.fromEntries(
            Object.entries(c.repoFiles || {}).map(([p, f]) => [p, fs.readFileSync(path.join(dir, f), 'utf8')]),
        ),
    };
    const comments = [];
    const judgeFailures = [];
    const outcomes = [];
    const stage = buildStage({ ...opts, codeHost: caseCodeHost(world, comments), judgeFailures, outcomes });
    const context = {
        organizationAndTeamData: ORG,
        platformType: 'GITHUB',
        repository: REPOSITORY,
        pullRequest: {
            number: c.pr.number,
            title: c.pr.title,
            body: c.pr.body,
            head: { ref: c.pr.headRef, sha: 'eval-head' },
            base: { ref: 'main' },
            user: { login: 'dev' },
        },
        changedFiles: filesOfDiff(world.current.diff),
        codeReviewConfig: { reviewOptions: { business_logic: true } },
        pipelineMetadata: {},
        statusInfo: {},
        errors: [],
    };
    try {
        const out = await stage.execute(context);
        return { outcome: out.businessLogicOutcome || null, decided: outcomes[0] || null, comments, judgeFailures, errors: out.errors || [] };
    } finally {
        world.current = null;
    }
}

module.exports = { startServices, reviewCase, observability, filesOfDiff, ORG };

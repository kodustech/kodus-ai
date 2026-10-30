/**
 * TASK-FINDER eval: when a tracker's MCP changes under Kody (a renamed tool,
 * a new answer shape, an argument it now requires), does business-logic
 * validation still read the right task, and never another one?
 *
 * Each case is a tracker server simulated with the tool names and read-only
 * marks the real one lists (Linear, Atlassian Rovo, Kodus Git Issues, a
 * ClickUp-style plugin), changed the way a server changes. The production
 * trackers read it first; when they miss, the production task finder runs on
 * a real model. The domain is invented.
 *
 *   node evals/task-finder/run.js --model=gpt-5.4-mini [--repeats=3] [--case=L2]
 *
 * A case passes when the expected task is read (or nothing is, for a task
 * that doesn't exist), no other task is taken, and no tool that writes is
 * called. Also reported: how often the finder had to step in, and its calls.
 *
 * The model is routed as production routes an org's for the
 * businessValidation task (evals/shared/model-route.js), and recorded with the
 * result.
 *
 * EXIT CODES: 0 = every case passed in every repeat, 1 = a case failed,
 *   2 = not measured (a model production can't route, or no key).
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts',
        format: 'cjs',
        target: 'es2021',
        sourcefile: filename,
        tsconfigRaw: {
            compilerOptions: {
                experimentalDecorators: true,
                useDefineForClassFields: false,
            },
        },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
if (process.env.HOME) {
    dotenv.config({
        path: path.join(process.env.HOME, '.kodus-dev/config'),
        override: true,
    });
}
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    }),
);
const MODEL = args.model || 'gpt-5.4-mini';
const REPEATS = Number(args.repeats || 1);
const ONLY = args.case ? String(args.case).split(',') : undefined;

// The model an org gets for the businessValidation task, routed as production
// routes it (evals/shared/model-route.js): a stored BYOK config, read by
// PermissionValidationService and resolved by resolveTaskSlot, the slot the
// service hands the finder (business-validation.service.ts).
const { orgRouteOrExit, evalPermissionService, EVAL_ORG } = require('../shared/model-route');
const ROUTE = orgRouteOrExit(MODEL);

const {
    createTaskFinder,
    aiSdkAgentRun,
} = require('../../libs/agents/business-validation/trackers/task-finder.ts');
const {
    LinearTracker,
} = require('../../libs/agents/business-validation/trackers/linear.tracker.ts');
const {
    JiraTracker,
} = require('../../libs/agents/business-validation/trackers/jira.tracker.ts');
const {
    GitIssuesTracker,
} = require('../../libs/agents/business-validation/trackers/git-issues.tracker.ts');
const {
    CustomMcpTracker,
} = require('../../libs/agents/business-validation/trackers/custom-mcp.tracker.ts');
const {
    TaskNotFoundError,
    TrackerUnavailableError,
} = require('../../libs/agents/business-validation/trackers/mcp-tool-session.ts');
const {
    resolveTasks,
} = require('../../libs/agents/business-validation/task-resolver.ts');
const {
    extractTaskReferences,
} = require('../../libs/agents/business-validation/task-references.ts');

const ORG = { organizationId: 'eval-org', teamId: 'eval-team' };

const tool = (name, properties = {}, readOnlyHint, required = []) => ({
    name,
    description: name.replace(/[_-]/g, ' '),
    inputSchema: { type: 'object', properties, required },
    ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
});
const str = { type: 'string' };
const num = { type: 'number' };

const STICKY = {
    title: 'Sticky notes: drag to reorder',
    description:
        '## Acceptance criteria\n- Notes can be dragged to a new position\n- The order is kept after a reload',
};
const OTHER = {
    title: 'Dark mode',
    description: '## Acceptance criteria\n- A toggle in settings',
};

/** Linear's read tools as its MCP lists them, plus the write ones a fetch must never call. */
const LINEAR_TOOLS = [
    tool('get_issue', { id: str }, true, ['id']),
    tool('list_issues', { query: str, team: str }, true),
    tool('get_team', { query: str }, true),
    tool('list_teams', {}, true),
    tool('list_comments', { issueId: str }, true),
    tool('save_issue', { id: str, title: str, description: str }, false),
    tool('save_comment', { issueId: str, body: str }, false),
    tool('delete_comment', { id: str }, false),
];

const ROVO_TOOLS = [
    tool('atlassianUserInfo', {}, true),
    tool('getAccessibleAtlassianResources', {}, true),
    tool('getJiraIssue', { cloudId: str, issueIdOrKey: str, fields: { type: 'array' } }, true, ['cloudId', 'issueIdOrKey']),
    tool('getVisibleJiraProjects', { cloudId: str }, true, ['cloudId']),
    tool('searchJiraIssuesUsingJql', { cloudId: str, jql: str }, true, ['cloudId', 'jql']),
    tool('editJiraIssue', { cloudId: str, issueIdOrKey: str, fields: { type: 'object' } }, false),
    tool('addCommentToJiraIssue', { cloudId: str, issueIdOrKey: str, commentBody: str }, false),
    tool('transitionJiraIssue', { cloudId: str, issueIdOrKey: str }, false),
];

const SITE = [{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }];
const PROJECTS = { values: [{ key: 'SHOP', name: 'Shop' }] };

function server(tools, handler) {
    const log = [];
    return {
        log,
        session: {
            called: [],
            tools: async () => tools,
            call: async function (name, a) {
                this.called.push(name);
                log.push(name);
                if (!tools.some((t) => t.name === name)) {
                    throw new TrackerUnavailableError(`Unknown tool: ${name}`);
                }
                return handler(name, a ?? {});
            },
            close: async () => undefined,
        },
        tools,
    };
}

const notFound = (what) => {
    throw new TaskNotFoundError(`${what} not found`);
};

const CASES = [
    {
        id: 'L1',
        what: 'Linear, current answer: the direct read finds it',
        ref: 'feat(SAA-96): sticky notes',
        expect: 'SAA-96',
        build: () =>
            server(LINEAR_TOOLS, (name, a) => {
                if (name === 'get_team') return { key: 'SAA', name: 'Sticky' };
                if (name === 'get_issue' && a.id === 'SAA-96') return { id: 'SAA-96', uuid: 'u-96', ...STICKY };
                return notFound('Issue');
            }),
        tracker: (s) => new LinearTracker(s),
    },
    {
        id: 'L2',
        what: 'Linear renamed get_issue to get_issue_v2 (issueId)',
        ref: 'feat(SAA-96): sticky notes',
        expect: 'SAA-96',
        build: () =>
            server(
                [tool('get_issue_v2', { issueId: str }, true, ['issueId']), ...LINEAR_TOOLS.filter((t) => t.name !== 'get_issue')],
                (name, a) => {
                    if (name === 'get_team') return { key: 'SAA' };
                    if (name === 'get_issue_v2' && String(a.issueId).toUpperCase() === 'SAA-96')
                        return { issue: { identifier: 'SAA-96', ...STICKY } };
                    if (name === 'list_issues') return { issues: [{ identifier: 'SAA-96', title: STICKY.title }] };
                    return notFound('Issue');
                },
            ),
        tracker: (s) => new LinearTracker(s),
    },
    {
        id: 'L3',
        what: 'Linear get_issue now takes only the internal id; a search maps the key to it',
        ref: 'SAA-96',
        expect: 'SAA-96',
        build: () =>
            server(LINEAR_TOOLS, (name, a) => {
                if (name === 'get_team') return { key: 'SAA' };
                if (name === 'get_issue') {
                    if (a.id === 'u-96') return { id: 'u-96', identifier: 'SAA-96', ...STICKY };
                    return notFound('Entity');
                }
                if (name === 'list_issues')
                    return {
                        issues: [
                            { id: 'u-12', identifier: 'SAA-12', title: OTHER.title },
                            { id: 'u-96', identifier: 'SAA-96', title: STICKY.title },
                        ],
                    };
                if (name === 'list_teams') return { teams: [{ key: 'SAA' }] };
                return notFound('Entity');
            }),
        tracker: (s) => new LinearTracker(s),
    },
    {
        id: 'L4',
        what: 'Linear typo SAA-999 (team exists): nothing is read, no other task taken',
        ref: 'SAA-999',
        expect: null,
        build: () =>
            server(LINEAR_TOOLS, (name) => {
                if (name === 'get_team') return { key: 'SAA' };
                if (name === 'list_issues')
                    return { issues: [{ id: 'SAA-96', ...STICKY }, { id: 'SAA-99', ...OTHER }] };
                if (name === 'list_teams') return { teams: [{ key: 'SAA' }] };
                return notFound('Issue');
            }),
        tracker: (s) => new LinearTracker(s),
    },
    {
        id: 'J1',
        what: 'Rovo renamed getJiraIssue to fetchJiraIssue',
        ref: 'Closes SHOP-12',
        expect: 'SHOP-12',
        build: () =>
            server(
                [
                    tool('fetchJiraIssue', { cloudId: str, issueIdOrKey: str }, true, ['cloudId', 'issueIdOrKey']),
                    ...ROVO_TOOLS.filter((t) => t.name !== 'getJiraIssue'),
                ],
                (name, a) => {
                    if (name === 'getAccessibleAtlassianResources') return SITE;
                    if (name === 'getVisibleJiraProjects') return PROJECTS;
                    if (name === 'fetchJiraIssue') {
                        if (a.cloudId !== 'cloud-1') throw new Error('cloudId is invalid');
                        if (a.issueIdOrKey === 'SHOP-12')
                            return { key: 'SHOP-12', fields: { summary: STICKY.title, description: STICKY.description } };
                    }
                    return notFound('Issue');
                },
            ),
        tracker: (s) => new JiraTracker(s),
    },
    {
        id: 'J2',
        what: 'Rovo answers getJiraIssue with the key under issueKey and the text under body',
        ref: 'Closes SHOP-12',
        expect: 'SHOP-12',
        build: () =>
            server(ROVO_TOOLS, (name, a) => {
                if (name === 'getAccessibleAtlassianResources') return SITE;
                if (name === 'getVisibleJiraProjects') return PROJECTS;
                if (name === 'getJiraIssue' && a.issueIdOrKey === 'SHOP-12')
                    return { issue: { issueKey: 'SHOP-12', summary: STICKY.title, body: STICKY.description } };
                if (name === 'searchJiraIssuesUsingJql')
                    return { issues: [{ key: 'SHOP-12', fields: { summary: STICKY.title } }] };
                return notFound('Issue');
            }),
        tracker: (s) => new JiraTracker(s),
    },
    {
        id: 'G1',
        what: 'Git Issues renamed its reader; another repository has a #12 too',
        ref: 'Closes #12',
        expect: '#12',
        repository: { owner: 'acme', name: 'notes' },
        build: () =>
            server(
                [
                    tool('KODUS_GET_ISSUE_V2', { owner: str, repo: str, number: num }, true, ['owner', 'repo', 'number']),
                    tool('KODUS_LIST_ISSUES', { owner: str, repo: str }, true),
                    tool('KODUS_CREATE_ISSUE_COMMENT', { owner: str, repo: str, number: num, body: str }, false),
                ],
                (name, a) => {
                    if (name === 'KODUS_GET_ISSUE_V2' && Number(a.number) === 12) {
                        const repo = `${a.owner}/${a.repo}`;
                        return {
                            number: 12,
                            html_url: `https://github.com/${repo}/issues/12`,
                            ...(repo === 'acme/notes' ? { title: STICKY.title, body: STICKY.description } : { title: OTHER.title, body: OTHER.description }),
                        };
                    }
                    if (name === 'KODUS_LIST_ISSUES') return [];
                    return notFound('Issue');
                },
            ),
        tracker: (s) => new GitIssuesTracker(s),
    },
    {
        id: 'C1',
        what: 'ClickUp-style plugin: a custom task id needs the workspace id and custom_task_ids',
        ref: 'Closes DEV-12',
        expect: 'DEV-12',
        build: () =>
            server(
                [
                    tool('clickup_get_workspaces', {}, undefined),
                    tool('clickup_get_task', { task_id: str, custom_task_ids: { type: 'boolean' }, team_id: str }, undefined, ['task_id']),
                    tool('clickup_update_task', { task_id: str, name: str }, undefined),
                    tool('clickup_create_task_comment', { task_id: str, comment_text: str }, undefined),
                ],
                (name, a) => {
                    if (name === 'clickup_get_workspaces') return { teams: [{ id: '9001', name: 'Acme' }] };
                    if (name === 'clickup_get_task') {
                        if (a.task_id !== 'DEV-12') return notFound('Task');
                        if (a.custom_task_ids !== true || String(a.team_id) !== '9001')
                            throw new Error('Team(s) not authorized: team_id is required when custom_task_ids is true');
                        return { id: '86abc12', custom_id: 'DEV-12', name: STICKY.title, description: STICKY.description };
                    }
                    return notFound('Task');
                },
            ),
        tracker: (s) => new CustomMcpTracker('ClickUp', s),
    },
];

const WRITE = /save|update|create|edit|delete|transition|comment|add/i;

async function runCase(c, slot) {
    const { session, log, tools } = c.build();
    const finderLog = [];
    const run = aiSdkAgentRun(slot, { organizationId: ORG.organizationId });
    const tracker = c.tracker(session).useFinder((reference, context) =>
        createTaskFinder(async (spec, prompt) => {
            try {
                await run(spec, prompt);
            } catch (e) {
                finderLog.push(`agent failed: ${e.message}`);
                throw e;
            }
        })({
            reference,
            tracker: c.tracker(session).name,
            repository: reference.kind === 'git_issue' ? (reference.repository ?? context.repository) : undefined,
            tools,
            call: (name, a) => {
                finderLog.push(name);
                return session.call(name, a);
            },
        }),
    );
    const references = extractTaskReferences({ title: c.ref });
    const started = Date.now();
    const resolution = await resolveTasks(references, [tracker], {
        organizationAndTeamData: ORG,
        ...(c.repository ? { repository: c.repository } : {}),
    });
    const task = resolution.kind === 'found' ? resolution.tasks[0].task : undefined;
    const wrote = log.filter((n) => WRITE.test(n) && !/^get|^list|^search|^fetch/i.test(n));
    const right =
        c.expect === null
            ? !task
            : !!task && task.id.endsWith(c.expect) && /drag to reorder/i.test(task.title ?? '');
    return {
        id: c.id,
        pass: right && !wrote.length,
        got: task ? `${task.id} · ${task.title}` : resolution.kind,
        byAgent: resolution.attempts.some((a) => a.byAgent),
        finderCalls: finderLog,
        wrote,
        ms: Date.now() - started,
    };
}

(async () => {
    // The model client's timers don't hold the loop; this does, until the end.
    const keepAlive = setInterval(() => undefined, 1000);
    const { LLM_TASK } = require('../../libs/llm/llm-tasks.ts');
    const slot = await evalPermissionService(ROUTE.storedConfig).resolveTaskSlot(EVAL_ORG, LLM_TASK.businessValidation, { ctx: {} });
    if (!slot && ROUTE.storedConfig) {
        console.error(`not measured: production resolves no businessValidation slot for ${MODEL}`);
        process.exit(2);
    }
    const resolved = slot ? `${slot.provider}:${slot.model}` : 'managed default';
    console.log(`model ${MODEL} via ${ROUTE.route} → ${resolved}`);
    const cases = CASES.filter((c) => !ONLY || ONLY.includes(c.id));
    const rows = [];
    for (let r = 1; r <= REPEATS; r++) {
        for (const c of cases) {
            let row;
            try {
                row = await runCase(c, slot);
            } catch (e) {
                row = { id: c.id, pass: false, got: `threw: ${e.message}`, finderCalls: [], wrote: [] };
            }
            rows.push({ ...row, repeat: r });
            console.log(
                `${row.pass ? '✅' : '❌'} ${c.id} r${r} ${c.what}\n     → ${row.got}${row.byAgent ? ' (finder)' : ''}${row.finderCalls.length ? ` · finder called ${row.finderCalls.join(' → ')}` : ''}${row.wrote.length ? ` · WROTE ${row.wrote.join(', ')}` : ''}${row.ms ? ` · ${(row.ms / 1000).toFixed(1)}s` : ''}`,
            );
        }
    }
    const passed = rows.filter((r) => r.pass).length;
    console.log(`\n${passed}/${rows.length} passed · model ${MODEL} (${resolved}) · ${REPEATS} repeat(s)`);
    clearInterval(keepAlive);
    if (args.output) fs.writeFileSync(args.output, JSON.stringify({ model: MODEL, route: ROUTE.route, resolved, rows }, null, 2));
    process.exit(passed === rows.length ? 0 : 1);
})();

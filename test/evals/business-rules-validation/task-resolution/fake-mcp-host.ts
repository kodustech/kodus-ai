import http from 'node:http';
import { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { KodusIssuesMcpServerFactory } from '@libs/mcp-server/services/kodus-issues-mcp-server.factory';
import { McpServerFactory } from '@libs/mcp-server/services/mcp-server.factory';
import { CodeManagementTools } from '@libs/mcp-server/tools/codeManagement.tools';
import { KodusIssuesTools } from '@libs/mcp-server/tools/kodusIssues.tools';
import { McpToolDefinition } from '@libs/mcp-server/types/mcp-tool.interface';

import { FakeCodeHost } from './fake-code-host';
import {
    ResolutionFixture,
    TrackerFixture,
    TrackerTask,
    TrackerTool,
} from './fixture.types';

export type ToolCall = {
    server: string;
    tool: string;
    args: Record<string, unknown>;
    kind: 'get' | 'list' | 'write' | 'kodus';
};

type Handler = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
) => Promise<void>;

/**
 * Every MCP server the business-logic fetch can reach, on 127.0.0.1:
 * - `/kodus`: Kodus MCP (real factory and PR/diff tools)
 * - `/issues`: Git Issues (real factory and tools)
 * - `/t/<integrationId>`: an external tracker, answering as the fixture says
 * Kodus's servers run their production factories over a fake git host; the
 * trackers are fakes, since their servers live outside this repository. Every
 * tool call is recorded.
 */
export class FakeMcpHost {
    readonly calls: ToolCall[] = [];
    private readonly handlers = new Map<string, Handler>();
    private server?: http.Server;
    private baseUrl = '';

    constructor(fixture: ResolutionFixture) {
        const host = new FakeCodeHost(fixture) as never;
        const code = new CodeManagementTools(host);
        // The principal check is not under test: pass the args through with
        // the org the run belongs to, as the real authorizer does.
        const authorizer = {
            authorize: async (
                _name: string,
                args: Record<string, unknown>,
            ) => ({
                ...args,
                organizationId: 'org-eval',
            }),
        } as never;
        const none = { getAllTools: () => [] } as never;

        const kodus = new McpServerFactory(
            this.recording(
                'kodus',
                [code.getPullRequest(), code.getPullRequestDiff()],
                () => 'kodus',
            ),
            none,
            none,
            authorizer,
        );
        const issues = new KodusIssuesMcpServerFactory(
            this.recording(
                'issues',
                new KodusIssuesTools(host).getAllTools(),
                (tool) => (tool === 'KODUS_GET_ISSUE' ? 'get' : 'list'),
            ),
            authorizer,
        );

        this.handlers.set(
            '/kodus',
            this.statelessHandler(() => kodus.create()),
        );
        this.handlers.set(
            '/issues',
            this.statelessHandler(() => issues.create()),
        );
        for (const tracker of fixture.trackers) {
            this.handlers.set(
                `/t/${tracker.integrationId}`,
                tracker.unavailable
                    ? async (_req, res) => {
                          res.writeHead(503).end('Service Unavailable');
                      }
                    : this.statelessHandler(async () => {
                          const transport = new StreamableHTTPServerTransport({
                              sessionIdGenerator: undefined,
                          });
                          const server = this.trackerServer(tracker);
                          await server.connect(transport);
                          return { server, transport };
                      }),
            );
        }
    }

    async start(): Promise<void> {
        this.server = http.createServer((req, res) => {
            this.route(req, res).catch(() => {
                if (!res.headersSent) {
                    res.writeHead(500);
                }
                res.end();
            });
        });
        await new Promise<void>((resolve) =>
            this.server!.listen(0, '127.0.0.1', resolve),
        );
        const { port } = this.server.address() as AddressInfo;
        this.baseUrl = `http://127.0.0.1:${port}`;
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (!server) {
            return;
        }
        // Stop accepting first, then drop what the MCP clients keep open.
        const closed = new Promise<void>((resolve) =>
            server.close(() => resolve()),
        );
        server.closeAllConnections();
        await closed;
    }

    url(path: string): string {
        return `${this.baseUrl}${path}`;
    }

    private async route(req: http.IncomingMessage, res: http.ServerResponse) {
        // Kodus's MCP endpoints are stateless and POST-only: GET (a long-lived
        // SSE stream) and DELETE get 405, as in mcp-controller.helper.ts.
        if (req.method !== 'POST') {
            res.writeHead(405, {
                'Allow': 'POST',
                'Content-Type': 'application/json',
            }).end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Method not allowed.' },
                    id: null,
                }),
            );
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        const handler = this.handlers.get((req.url ?? '').split('?')[0]);
        if (!handler) {
            res.writeHead(404).end();
            return;
        }
        await handler(req, res, raw ? JSON.parse(raw) : undefined);
    }

    /** One server and transport per request, as the stateless MCP endpoints do. */
    private statelessHandler(
        create: () => Promise<{
            server: { close(): Promise<void> };
            transport: StreamableHTTPServerTransport;
        }>,
    ): Handler {
        return async (req, res, body) => {
            const { server, transport } = await create();
            res.on('close', () => {
                void transport.close();
                void server.close();
            });
            await transport.handleRequest(req, res, body);
        };
    }

    /** The tools, as a `getAllTools()` provider whose `execute` records the call. */
    private recording(
        server: string,
        tools: McpToolDefinition[],
        kindOf: (tool: string) => ToolCall['kind'],
    ) {
        const wrapped = tools.map((tool) => ({
            ...tool,
            execute: (args: Record<string, unknown>, extra: unknown) => {
                this.calls.push({
                    server,
                    tool: tool.name,
                    args,
                    kind: kindOf(tool.name),
                });
                return tool.execute(args, extra);
            },
        }));
        return { getAllTools: () => wrapped } as never;
    }

    private trackerServer(tracker: TrackerFixture): Server {
        const server = new Server(
            { name: tracker.appName, version: '1.0.0' },
            { capabilities: { tools: {} } },
        );
        const tools: TrackerTool[] = [
            ...tracker.tools,
            ...(tracker.extraWriteTools ?? []).map((name): TrackerTool => ({
                name,
                kind: 'write',
            })),
        ];

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description ?? tool.name,
                inputSchema: tool.inputSchema ?? {
                    type: 'object',
                    properties: {},
                },
                annotations:
                    tool.kind === 'write' ? undefined : { readOnlyHint: true },
            })),
        }));

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const tool = tools.find((t) => t.name === request.params.name);
            const args = (request.params.arguments ?? {}) as Record<
                string,
                unknown
            >;
            if (!tool) {
                return this.toolError(`Unknown tool ${request.params.name}`);
            }

            const writes =
                tool.kind === 'write' ||
                (tool.readAction !== undefined &&
                    args.action !== tool.readAction);
            this.calls.push({
                server: tracker.integrationId,
                tool: tool.name,
                args,
                kind: writes
                    ? 'write'
                    : tool.kind === 'sites'
                      ? 'list'
                      : tool.kind,
            });

            if (writes) {
                return this.toolText({ success: true });
            }
            if (tool.kind === 'sites') {
                return this.toolText([
                    {
                        id: `cloud-${tracker.integrationId}`,
                        url: 'https://acme.atlassian.net',
                        name: 'acme',
                        scopes: ['read:jira-work'],
                    },
                ]);
            }
            if (tool.kind === 'list') {
                return this.toolText(
                    tracker.tasks.map((task) => this.shape(tracker, task)),
                );
            }

            const requested = String(args[tool.idArg ?? 'id'] ?? '').trim();
            const task = tracker.tasks.find((t) =>
                this.sameId(tracker, t.id, requested),
            );
            if (!task) {
                return this.toolError(`Not found: ${requested || '(no id)'}`);
            }
            return this.toolText(this.shape(tracker, task));
        });

        return server;
    }

    private sameId(tracker: TrackerFixture, taskId: string, requested: string) {
        if (!requested) {
            return false;
        }
        if (tracker.responseShape === 'azure') {
            return String(Number(requested)) === taskId;
        }
        return taskId.toLowerCase() === requested.toLowerCase();
    }

    /** The task as the real server wraps it. */
    private shape(tracker: TrackerFixture, task: TrackerTask) {
        const criteria = task.acceptanceCriteria?.length
            ? `\n\nAcceptance criteria:\n${task.acceptanceCriteria
                  .map((c) => `- ${c}`)
                  .join('\n')}`
            : '';
        const description = `${task.description ?? ''}${criteria}`;

        switch (tracker.responseShape) {
            case 'linear_markdown':
                return `# ${task.id}: ${task.title}\n\n${description}`;
            case 'linear':
                return {
                    id: `uuid-${task.id}`,
                    identifier: task.id,
                    title: task.title,
                    description,
                    url: `https://linear.app/acme/issue/${task.id.toLowerCase()}`,
                    state: 'Todo',
                };
            case 'jira':
                return {
                    id: `100${task.id.replace(/\D/g, '')}`,
                    key: task.id,
                    fields: { summary: task.title, description },
                };
            case 'azure':
                return {
                    id: Number(task.id),
                    fields: {
                        'System.Title': task.title,
                        'System.Description': description,
                        'System.WorkItemType': 'User Story',
                    },
                };
        }
    }

    private toolText(value: unknown) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return { content: [{ type: 'text', text }] };
    }

    private toolError(message: string) {
        return { isError: true, content: [{ type: 'text', text: message }] };
    }
}

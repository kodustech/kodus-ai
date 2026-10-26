/**
 * The tool metadata the conversation agent acts on, carried end to end: the
 * Kodus MCP server's real tool definitions, served by the SDK's server over
 * HTTP, listed by the local MCP adapter's SDK client. The proactive hint is
 * not a standard annotation, so this is the path that drops it if it travels
 * anywhere the SDK's schemas strip.
 */
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { createLogger } from '@libs/core/log/logger';
import { McpServerFactory } from '@libs/mcp-server/services/mcp-server.factory';
import {
    CodeManagementTools,
    KodyIssuesTools,
    KodyRulesTools,
} from '@libs/mcp-server/tools';
import { McpToolAuthorizer } from '@libs/mcp-server/auth/mcp-tool-authorizer.service';
import {
    KODUS_ISSUES_INTEGRATION_ID,
    KODUS_MCP_INTEGRATION_ID,
} from '@libs/mcp-server/utils/mcp-auth.constants';
import { PROACTIVE_HINT_META_KEY } from '@libs/mcp-server/types/mcp-tool.interface';

import { buildProactiveBlock } from '../agents/conversation/conversation-prompt';
import { connectMcpTools } from './mcp-tools';

// The tool builders only close over their services (used inside `execute`),
// and listing tools never executes one.
const stub = () => ({}) as never;

const logger = createLogger('mcp-tools.spec');

const kodyRulesTools = new KodyRulesTools(stub(), stub(), stub());
const kodyIssuesTools = new KodyIssuesTools(stub(), stub());

// Every tool the server declares as offerable: a hint, and not destructive.
const DECLARED_OFFERS = [
    ...kodyRulesTools.getAllTools(),
    ...kodyIssuesTools.getAllTools(),
]
    .filter(
        (t) =>
            t._meta?.[PROACTIVE_HINT_META_KEY] &&
            t.annotations?.destructiveHint !== true,
    )
    .map((t) => ({ tool: t.name, hint: t._meta![PROACTIVE_HINT_META_KEY]! }));

function proactiveHintOf(toolName: string): string {
    const tool = kodyRulesTools.getAllTools().find((t) => t.name === toolName);
    const hint = tool?._meta?.[PROACTIVE_HINT_META_KEY];
    if (typeof hint !== 'string') {
        throw new Error(`${toolName} declares no proactive hint`);
    }
    return hint;
}

describe('connectMcpTools against the Kodus MCP server', () => {
    let server: http.Server;
    let url: string;

    beforeAll(async () => {
        const factory = new McpServerFactory(
            new CodeManagementTools(stub()),
            kodyRulesTools,
            kodyIssuesTools,
            new McpToolAuthorizer(stub()),
        );

        const serve = async (
            raw: string,
            req: http.IncomingMessage,
            res: http.ServerResponse,
        ) => {
            const { server: mcp, transport } = await factory.create();
            res.once('close', () => {
                for (const [part, closing] of [
                    ['transport', transport.close()],
                    ['server', mcp.close()],
                ] as const) {
                    closing.catch((error: unknown) =>
                        logger.error({
                            message: 'Test MCP server cleanup failed',
                            context: 'mcp-tools.spec',
                            metadata: {
                                part,
                                errorMessage:
                                    error instanceof Error
                                        ? error.message
                                        : 'unknown error',
                            },
                        }),
                    );
                }
            });
            await transport.handleRequest(req, res, JSON.parse(raw));
        };

        server = http.createServer((req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405).end();
                return;
            }
            let raw = '';
            req.on('data', (chunk) => (raw += chunk));
            req.on('end', () => {
                serve(raw, req, res).catch((error: unknown) => {
                    // Answer instead of leaving the client waiting, so a broken
                    // server fails the spec with its error, not a timeout.
                    if (!res.headersSent) {
                        res.writeHead(500, { 'content-type': 'text/plain' });
                    }
                    res.end(String(error));
                });
            });
        });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    // connectMcpTools never throws: it reports through onError and returns
    // no tools, which would make the assertions below pass for a server that
    // never answered. Fail the spec instead.
    const connect = async (integrationId: string) => {
        const errors: string[] = [];
        const mcp = await connectMcpTools(
            [{ name: 'kodus', type: 'http', url, integrationId }],
            {
                onError: (error, serverName) =>
                    errors.push(`${serverName}: ${error.message}`),
            },
        );
        if (errors.length || !mcp.tools.KODUS_CREATE_MEMORY) {
            await mcp.close();
            throw new Error(
                `the Kodus MCP tools did not load: ${errors.join('; ') || 'no tools listed'}`,
            );
        }
        return mcp;
    };

    it('carries the proactive hint from a first-party server', async () => {
        const mcp = await connect(KODUS_MCP_INTEGRATION_ID);
        try {
            expect(mcp.metadata.KODUS_CREATE_MEMORY).toEqual({
                readOnlyHint: false,
                destructiveHint: false,
                proactiveHint: proactiveHintOf('KODUS_CREATE_MEMORY'),
            });
            expect(mcp.metadata.KODUS_CREATE_KODY_RULE.proactiveHint).toBe(
                proactiveHintOf('KODUS_CREATE_KODY_RULE'),
            );
            expect(mcp.metadata.KODUS_DELETE_KODY_RULE).toEqual({
                readOnlyHint: false,
                destructiveHint: true,
            });
        } finally {
            await mcp.close();
        }
    });

    it('trusts the Kodus issues server as first-party too', async () => {
        const mcp = await connect(KODUS_ISSUES_INTEGRATION_ID);
        try {
            expect(mcp.metadata.KODUS_CREATE_MEMORY.proactiveHint).toBe(
                proactiveHintOf('KODUS_CREATE_MEMORY'),
            );
        } finally {
            await mcp.close();
        }
    });

    it('ignores a proactive hint from any other server, keeping its annotations', async () => {
        const mcp = await connect('linear-default');
        try {
            expect(mcp.metadata.KODUS_CREATE_MEMORY).toEqual({
                readOnlyHint: false,
                destructiveHint: false,
            });
        } finally {
            await mcp.close();
        }
    });

    // What the issue asked for: the prompt itself, not only the metadata.
    it("lists every offer the first-party server declares in the prompt's proactive block", async () => {
        const mcp = await connect(KODUS_MCP_INTEGRATION_ID);
        try {
            const block = buildProactiveBlock(
                Object.keys(mcp.tools),
                mcp.metadata,
            );

            expect(DECLARED_OFFERS.length).toBeGreaterThan(0);
            for (const { tool, hint } of DECLARED_OFFERS) {
                expect(block).toContain(`- ${tool} — ${hint}`);
            }
            expect(block).not.toContain('KODUS_DELETE_KODY_RULE');
        } finally {
            await mcp.close();
        }
    });

    it('renders no proactive block from the same tools on any other server', async () => {
        const mcp = await connect('linear-default');
        try {
            expect(
                buildProactiveBlock(Object.keys(mcp.tools), mcp.metadata),
            ).toBe('');
        } finally {
            await mcp.close();
        }
    });
});

/**
 * The tool metadata the conversation agent acts on, carried end to end: the
 * Kodus MCP server's real tool definitions, served by the SDK's server over
 * HTTP, listed by the local MCP adapter's SDK client. The proactive hint is
 * not a standard annotation, so this is the path that drops it if it travels
 * anywhere the SDK's schemas strip.
 */
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

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

import { connectMcpTools } from './mcp-tools';

// The tool builders only close over their services (used inside `execute`),
// and listing tools never executes one.
const stub = () => ({}) as never;

const kodyRulesTools = new KodyRulesTools(stub(), stub(), stub());

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
            new KodyIssuesTools(stub(), stub()),
            new McpToolAuthorizer(stub()),
        );

        server = http.createServer((req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405).end();
                return;
            }
            let raw = '';
            req.on('data', (chunk) => (raw += chunk));
            req.on('end', async () => {
                const { server: mcp, transport } = await factory.create();
                res.once('close', () => {
                    void transport.close();
                    void mcp.close();
                });
                await transport.handleRequest(req, res, JSON.parse(raw));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    const connect = (integrationId: string) =>
        connectMcpTools([
            {
                name: 'kodus',
                type: 'http',
                url,
                integrationId,
            },
        ]);

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
});

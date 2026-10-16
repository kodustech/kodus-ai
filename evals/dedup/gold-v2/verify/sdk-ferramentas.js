/**
 * #1821: no caminho do Agent SDK (Claude por assinatura), o verify e o nit leem o
 * repositorio com as MESMAS ferramentas que os outros modelos recebem (grep,
 * readFile, listDir do eval), expostas por MCP, e nao com as nativas do Claude Code.
 */
function servidorRepo(sdk, ferramentas) {
    const z = sdk.z;
    const txt = (t) => ({ content: [{ type: 'text', text: String(t) }] });
    const tools = [
        sdk.tool('grep', ferramentas.grep.description, { pattern: z.string(), path: z.string().optional(), glob: z.string().optional() },
            async (a) => txt(await ferramentas.grep.execute(a))),
        sdk.tool('readFile', ferramentas.readFile.description, { path: z.string(), startLine: z.number().optional(), endLine: z.number().optional() },
            async (a) => txt(await ferramentas.readFile.execute(a))),
        sdk.tool('listDir', ferramentas.listDir.description, { path: z.string(), maxDepth: z.number().optional() },
            async (a) => txt(await ferramentas.listDir.execute(a))),
    ];
    return {
        mcpServers: { repo: sdk.createSdkMcpServer({ name: 'repo', version: '1', tools }) },
        allowedTools: tools.map((t) => `mcp__repo__${t.name}`),
    };
}

module.exports = { servidorRepo };

/**
 * #1821: pelo Agent SDK (Claude por assinatura) o modelo le o repositorio com as
 * MESMAS ferramentas que os outros modelos recebem: as de producao (buildAgentTools)
 * sobre o sandbox local completo, com exec (padrao), ou sobre o E2B. Expostas por
 * MCP; as ferramentas nativas do Claude Code (Read, Grep, Glob, Bash) nao entram em
 * nenhum script: nao existem em producao.
 *
 *   const { servidorRepo } = require('../shared/claude-sdk-repo');
 *   sdk.query({ prompt, options: { ...servidorRepo(sdk, dirOuFerramentas), ... } })
 *
 * dirOuFerramentas: a pasta do repositorio (worktree) ou o mapa de ferramentas que o
 * script ja montou (nome -> { description, inputSchema, execute }).
 */
const path = require('path');

const DESCRICAO = 'You can read the repository at the pull request head with the tools provided.';

function ferramentasDaPasta(dir) {
    const { comandosSandboxLocal, ferramentasProducao } = require('./local-sandbox');
    return ferramentasProducao(comandosSandboxLocal(dir));
}

function servidorRepo(sdk, dirOuFerramentas) {
    const mapa = typeof dirOuFerramentas === 'string' ? ferramentasDaPasta(dirOuFerramentas) : dirOuFerramentas;
    const { shapeDe } = require(path.join(__dirname, '..', 'investigation', 'claude-sdk-runner'));
    const txt = (t) => ({ content: [{ type: 'text', text: String(t) }] });
    const tools = Object.entries(mapa)
        .filter(([, def]) => def && typeof def.execute === 'function')
        .map(([nome, def]) => {
            const schema = def.inputSchema && def.inputSchema.jsonSchema ? def.inputSchema.jsonSchema : def.inputSchema;
            return sdk.tool(nome, def.description || nome, shapeDe(sdk.z, schema), async (a) => {
                try { return txt(await def.execute(a)); } catch (e) { return txt(`Error: ${e?.message || e}`); }
            });
        });
    return {
        tools: [],
        mcpServers: { repo: sdk.createSdkMcpServer({ name: 'repo', version: '1', tools }) },
        allowedTools: tools.map((t) => `mcp__repo__${t.name}`),
    };
}

module.exports = { servidorRepo, DESCRICAO };

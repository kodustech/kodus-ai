/**
 * #1821: pelo Agent SDK (Claude por assinatura) o modelo le o repositorio com as
 * MESMAS ferramentas que os outros modelos recebem no eval (grep, readFile,
 * listDir), expostas por MCP. As ferramentas nativas do Claude Code (Read, Grep,
 * Glob, Bash) nao entram em nenhum script: nao existem em producao e deixariam o
 * Claude com um conjunto diferente dos outros modelos.
 *
 *   const { servidorRepo } = require('../shared/claude-sdk-repo');
 *   const repo = servidorRepo(sdk, dirOuFerramentas);
 *   sdk.query({ prompt, options: { ...REPO_SEM_NATIVAS, ...repo, ... } })
 *
 * dirOuFerramentas: a pasta do repositorio (worktree) ou um objeto com grep/readFile/listDir
 * (cada um com execute) ja montado pelo script.
 */
const path = require('path');

const DESCRICAO = 'You can read the repository at the pull request head with the grep, readFile and listDir tools.';

function ferramentasDaPasta(dir) {
    const { LocalRepoCommands } = require(path.join(__dirname, '..', 'investigation', 'local-repo-commands'));
    const cmd = new LocalRepoCommands(dir);
    return {
        grep: { description: 'Search the repository for a regex pattern.', execute: async ({ pattern, path: p, glob }) => String(await cmd.grep(pattern, p, glob)).slice(0, 6000) },
        readFile: {
            description: 'Read a file, optionally a line range.',
            execute: async ({ path: p, startLine, endLine }) => {
                const t = String(await cmd.read(p, startLine, endLine));
                const b = Number(startLine) > 0 ? Number(startLine) : 1;
                return t.split('\n').map((l, k) => `${b + k}: ${l}`).join('\n').slice(0, 12000);
            },
        },
        listDir: { description: 'List a directory of the repository.', execute: async ({ path: p, maxDepth }) => String(await cmd.listDir(p, maxDepth)).slice(0, 6000) },
    };
}

function servidorRepo(sdk, dirOuFerramentas) {
    const f = typeof dirOuFerramentas === 'string' ? ferramentasDaPasta(dirOuFerramentas) : dirOuFerramentas;
    const z = sdk.z;
    const txt = (t) => ({ content: [{ type: 'text', text: String(t) }] });
    const tools = [
        sdk.tool('grep', f.grep.description, { pattern: z.string(), path: z.string().optional(), glob: z.string().optional() }, async (a) => txt(await f.grep.execute(a))),
        sdk.tool('readFile', f.readFile.description, { path: z.string(), startLine: z.number().optional(), endLine: z.number().optional() }, async (a) => txt(await f.readFile.execute(a))),
        sdk.tool('listDir', f.listDir.description, { path: z.string(), maxDepth: z.number().optional() }, async (a) => txt(await f.listDir.execute(a))),
    ];
    return {
        tools: [],
        mcpServers: { repo: sdk.createSdkMcpServer({ name: 'repo', version: '1', tools }) },
        allowedTools: tools.map((t) => `mcp__repo__${t.name}`),
    };
}

module.exports = { servidorRepo, DESCRICAO };

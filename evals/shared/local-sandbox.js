/**
 * #1821: o sandbox local de producao (LocalSandboxService, o caminho self-hosted)
 * completo, com exec, sobre um worktree do PR: o mesmo grep/read/listDir/exec que um
 * cliente self-hosted entrega ao agente. E o padrao do eval no finder, no verify e
 * no nit; RECALL_SANDBOX=e2b troca pelo E2B de producao (evals/shared/e2b-sandbox.js).
 *
 * O exec local so roda programas que leem arquivos (lista fechada do proprio
 * servico: sem rg, sem compiladores), entao checkTypes e o grep com contexto caem
 * nos mesmos fallbacks que caem num self-hosted.
 */
const path = require('path');

function comandosSandboxLocal(repoDir) {
    const { LocalSandboxService } = require(path.join(__dirname, '..', '..', 'libs/sandbox/infrastructure/providers/local-sandbox.service.ts'));
    // buildRemoteCommands e privado no TypeScript; nao le estado da instancia, e o
    // construtor ignora o ConfigService.
    const inner = new LocalSandboxService(undefined).buildRemoteCommands(repoDir);
    // calls: so para a metrica de fidelidade do trace (toda resposta e servida).
    const commands = { calls: [], unexpectedCalls: [] };
    for (const name of ['grep', 'read', 'listDir', 'exec']) {
        const fn = inner[name];
        if (typeof fn !== 'function') continue;
        const kind = name === 'read' ? 'readFile' : name;
        commands[name] = (...args) => {
            commands.calls.push({ kind, actual: args, matched: true });
            return fn(...args);
        };
    }
    return commands;
}

/** As ferramentas que o agente de producao recebe sobre esses comandos (buildAgentTools). */
function ferramentasProducao(commands, repositoryFullName) {
    const { buildAgentTools } = require(path.join(__dirname, '..', '..', 'libs/code-review/infrastructure/agents/engine/agent-tools.factory.ts'));
    return buildAgentTools(commands, undefined, repositoryFullName);
}

module.exports = { comandosSandboxLocal, ferramentasProducao };

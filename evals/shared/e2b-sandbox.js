/**
 * #1821: o sandbox E2B de producao (E2BSandboxService, template de producao,
 * com exec) para um caso do benchmark, no commit da head do PR. Mede o tempo de
 * criar + clonar e o de cada chamada de ferramenta.
 *
 *   const { abreSandboxE2B } = require('../shared/e2b-sandbox');
 *   const sb = await abreSandboxE2B(vars, 'finder');
 *   // sb.commands: RemoteCommands (grep/read/listDir/exec); sb.stats(); await sb.cleanup();
 *
 * Le do .env so as chaves do E2B, sem mexer no resto do ambiente do eval.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const CHAVES = ['API_E2B_KEY', 'API_E2B_TEMPLATE_ID'];

function configE2B() {
    const cfg = {};
    try {
        const env = require('dotenv').parse(fs.readFileSync(path.join(RAIZ, '.env')));
        for (const k of CHAVES) if (env[k]) cfg[k] = env[k];
    } catch {}
    for (const k of CHAVES) if (process.env[k]) cfg[k] = process.env[k];
    if (!cfg.API_E2B_KEY) throw new Error('API_E2B_KEY ausente (.env ou ambiente)');
    if (!cfg.API_E2B_TEMPLATE_ID) throw new Error('API_E2B_TEMPLATE_ID ausente: sem template o sandbox nao e o de producao');
    return cfg;
}

async function abreSandboxE2B(vars, etapa) {
    const cfg = configE2B();
    const { E2BSandboxService } = require(path.join(RAIZ, 'libs/sandbox/infrastructure/providers/e2b-sandbox.service.ts'));
    const svc = new E2BSandboxService({ get: (k) => cfg[k] });
    const t0 = Date.now();
    // checkoutSha: o commit exato da head, igual ao worktree local do eval. Produção
    // busca refs/pull/<n>/head e o branch base; as ferramentas da revisao nao usam o base.
    const inst = await svc.createSandboxWithRepo({
        cloneUrl: `https://github.com/${vars.repositoryFullName}.git`,
        authToken: '',
        branch: '',
        platform: 'github',
        checkoutSha: vars.benchmarkHeadRef,
        sandboxMetadata: { stage: `eval-${etapa}` },
    });
    const criaMs = Date.now() - t0;
    const st = { criaMs, chamadas: 0, msFerramentas: 0, porTipo: {} };
    const commands = { calls: [], unexpectedCalls: [] };
    for (const nome of ['grep', 'read', 'listDir', 'exec']) {
        const fn = inst.remoteCommands[nome];
        if (typeof fn !== 'function') continue;
        const kind = nome === 'read' ? 'readFile' : nome;
        commands[nome] = async (...args) => {
            const t = Date.now();
            try {
                return await fn(...args);
            } finally {
                const ms = Date.now() - t;
                st.chamadas++; st.msFerramentas += ms;
                const p = st.porTipo[kind] || (st.porTipo[kind] = { n: 0, ms: 0 });
                p.n++; p.ms += ms;
                commands.calls.push({ kind, actual: args, matched: true, ms });
            }
        };
    }
    return { commands, sandboxId: inst.sandboxId, stats: () => ({ ...st }), cleanup: () => inst.cleanup() };
}

module.exports = { abreSandboxE2B };

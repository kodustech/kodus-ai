/**
 * Registra o Langfuse para os scripts OFFLINE desta investigação.
 *
 * Por que precisa existir: o registro mora no `agent-provider.js`, que só é
 * carregado pelo `run-recall.js`. Os scripts de replay (redutor, verify,
 * painel, sondagens) chamam `generateText` direto com o modelo da assinatura e
 * nunca passam por ele — então rodaram o dia inteiro sem emitir um único span,
 * e o ambiente `benchmark` ficou vazio justamente nos experimentos que mais
 * precisavam ser auditados passo a passo.
 *
 * Mesma ordem do agent-provider, pelos mesmos dois motivos: `shouldTrace()` lê
 * as chaves, que não existem antes do dotenv; e `.env.local` carrega com
 * `override: true`, então o nome do ambiente só pode ser decidido depois dos
 * dois arquivos.
 *
 * `flush()` é exportado à parte porque um script que termina e sai leva os
 * spans pendentes junto — o processador exporta em lote.
 */
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });

let lf = null;
const lfMod = () => lf || (lf = require(path.join(__dirname, '../../libs/core/log/langfuse.ts')));

function registerTracing(runName) {
    process.env.LANGFUSE_ENVIRONMENT = process.env.LANGFUSE_ENVIRONMENT || 'benchmark';
    try {
        lf = require(path.join(__dirname, '../../libs/core/log/langfuse.ts'));
        lf.registerLangfuseStandalone();
        lf.registerLangfuseAiSdkTelemetry();
        const on =
            process.env.LANGFUSE_TRACING === 'true' &&
            !!process.env.LANGFUSE_PUBLIC_KEY &&
            !!process.env.LANGFUSE_SECRET_KEY;
        console.log(
            on
                ? `[langfuse] tracing ON · env=${process.env.LANGFUSE_ENVIRONMENT} · run=${runName}`
                : `[langfuse] tracing OFF · TRACING=${process.env.LANGFUSE_TRACING} PUBLIC_KEY=${process.env.LANGFUSE_PUBLIC_KEY ? 'set' : 'MISSING'}`,
        );
    } catch (err) {
        console.warn(`[langfuse] falhou ao registrar: ${String(err).slice(0, 160)}`);
    }
}

/**
 * Telemetria por chamada. Duas armadilhas, as duas pagas aqui:
 *
 * `isEnabled` é opt-in por chamada — sem ele o AI SDK não emite nada, mesmo
 * com o processador instalado.
 *
 * E o campo `telemetry.metadata` NÃO EXISTE mais no AI SDK 7: passá-lo faz o
 * metadata ser descartado em silêncio. O caminho atual é `runtimeContext` mais
 * `includeRuntimeContext`, que é exatamente o que `toAiSdkTelemetryArgs`
 * monta. A primeira versão disto usava o campo removido, e o resultado foram
 * 34 traces no ambiente benchmark todos com nome vazio e metadata {}.
 */
const tele = (runName, meta = {}) => {
    try {
        const { buildLangfuseTelemetry, toAiSdkTelemetryArgs } = lfMod();
        const cfg = buildLangfuseTelemetry(runName, {
            ...Object.fromEntries(
                Object.entries(meta).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
            ),
        });
        const { telemetry, runtimeContext } = toAiSdkTelemetryArgs(cfg);
        return {
            experimental_telemetry: telemetry,
            ...(runtimeContext ? { runtimeContext } : {}),
        };
    } catch {
        return { experimental_telemetry: { isEnabled: true, functionId: runName } };
    }
};

/**
 * Nomeia o TRACE (não só a observação). Sem isto cada chamada sobe como um
 * span solto e a lista do Langfuse fica com dezenas de linhas anônimas —
 * impossível dizer qual experimento produziu qual cadeia.
 */
function comTrace(attrs, fn) {
    try {
        return lfMod().withLangfuseTrace(attrs, fn);
    } catch {
        return fn();
    }
}

async function flush() {
    try { await lf?.flushLangfuse?.(); } catch {}
}

module.exports = { registerTracing, tele, comTrace, flush };

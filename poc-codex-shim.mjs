/**
 * PoC parte 2: valida o shim de libs/llm/codex-subscription-model.ts
 *
 * Pergunta única: com o wrapper, `generateText` (que é o que o
 * ai-sdk-agent-runner chama) funciona sobre um endpoint streaming-only?
 *
 * Compila o .ts com esbuild em memória e importa, para testar o arquivo real
 * em vez de uma cópia.
 */
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { generateText, tool } from 'ai';
import { z } from 'zod';

const SRC = 'libs/llm/codex-subscription-model.ts';
const OUT = path.resolve('.poc-codex-subscription-model.mjs');

await build({
    entryPoints: [SRC],
    outfile: OUT,
    bundle: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
});

const { buildCodexSubscriptionModel, CODEX_PROVIDER_OPTIONS } = await import(
    `file://${OUT}?t=${fs.statSync(OUT).mtimeMs}`
);

const MODEL = process.env.POC_MODEL || 'gpt-5.6-luna';
const model = buildCodexSubscriptionModel(MODEL);

const tools = {
    readFile: tool({
        description: 'Lê um arquivo do repositório.',
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path: p }) =>
            `// ${p}\nexport const key = process.env.SECRET_KEY;\n`,
    }),
    grep: tool({
        description: 'Busca um padrão regex no repositório.',
        inputSchema: z.object({ pattern: z.string() }),
        execute: async ({ pattern }) => `src/config.ts:2: match para ${pattern}`,
    }),
};

console.log(`\n=== PoC shim · generateText sobre endpoint streaming-only · ${MODEL} ===\n`);

// 1. generateText simples
try {
    const r = await generateText({
        model,
        providerOptions: CODEX_PROVIDER_OPTIONS,
        system: 'Responda em uma linha começando com KODUS_OK.',
        messages: [{ role: 'user', content: 'diga ping' }],
    });
    console.log('✅ generateText simples —', JSON.stringify(r.text.slice(0, 70)));
    console.log('   usage:', JSON.stringify(r.usage), '| finish:', r.finishReason);
} catch (e) {
    console.log('❌ generateText simples —', String(e.message).slice(0, 200));
}

// 2. generateText multi-step com tools — o caminho real do finder
try {
    const r = await generateText({
        model,
        providerOptions: CODEX_PROVIDER_OPTIONS,
        tools,
        stopWhen: (s) => (s.steps?.length ?? 0) >= 5,
        system:
            'Você é o revisor de código da Kodus. Investigue com as ferramentas ' +
            'antes de concluir. Termine com uma linha começando com KODUS_OK.',
        messages: [
            {
                role: 'user',
                content:
                    'src/config.ts lê process.env direto? Use grep e depois readFile.',
            },
        ],
    });
    const called = (r.steps ?? []).flatMap((s) =>
        (s.toolCalls ?? []).map((c) => c.toolName),
    );
    console.log('✅ generateText + tools —', `steps=${r.steps?.length ?? 0}`,
        `tools=[${called.join(', ')}]`);
    console.log('   texto:', JSON.stringify(String(r.text).slice(0, 90)));
    console.log('   usage:', JSON.stringify(r.usage));
} catch (e) {
    console.log('❌ generateText + tools —', String(e.message).slice(0, 250));
}

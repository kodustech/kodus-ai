/**
 * PoC: rodar o harness da Kodus por baixo da assinatura ChatGPT (Codex OAuth).
 *
 * Valida, em ordem de risco:
 *   1. transporte  — o AI SDK fala com chatgpt.com/backend-api/codex?
 *   2. streaming   — o backend exige stream:true; generateText funciona?
 *   3. TOOL CALLING — o finder depende de grep/readFile/listDir; passa?
 *   4. system prompt próprio — sem prompt de identidade do Codex?
 *
 * Uso: node poc-codex-subscription.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, tool } from 'ai';
import { z } from 'zod';

const auth = JSON.parse(
    fs.readFileSync(`${os.homedir()}/.codex/auth.json`, 'utf8'),
);
const TOKEN = auth.tokens.access_token;
const ACCOUNT = auth.tokens.account_id;
const MODEL = process.env.POC_MODEL || 'gpt-5.6-luna';

const codex = createOpenAI({
    apiKey: TOKEN,
    baseURL: 'https://chatgpt.com/backend-api/codex',
    headers: {
        'chatgpt-account-id': ACCOUNT,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
    },
});

const model = codex.responses(MODEL);

// Espelha as ferramentas reais do finder (agent-tools.factory registra
// grep/readFile/listDir/findFile). Se tool calling não passar, o caminho morre.
const tools = {
    readFile: tool({
        description: 'Lê um arquivo do repositório.',
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => `// conteúdo simulado de ${path}\nconst x = process.env.SECRET;\n`,
    }),
    grep: tool({
        description: 'Busca um padrão regex no repositório.',
        inputSchema: z.object({ pattern: z.string() }),
        execute: async ({ pattern }) => `src/config.ts:12: match para ${pattern}`,
    }),
};

const SYSTEM =
    'Você é o revisor de código da Kodus. Use as ferramentas disponíveis para ' +
    'investigar antes de responder. Ao terminar, responda em uma linha começando ' +
    'com KODUS_OK seguido do que encontrou.';

function log(step, ok, detail) {
    console.log(`${ok ? '✅' : '❌'} ${step}${detail ? ' — ' + detail : ''}`);
}

// ── 1+2: generateText (não-streaming), que é o que o runner de vocês usa ──
async function testGenerateText() {
    try {
        const r = await generateText({
            model,
            providerOptions: { openai: { store: false } },
            system: SYSTEM,
            messages: [{ role: 'user', content: 'Diga apenas: KODUS_OK ping' }],
        });
        log('generateText (não-streaming)', true, JSON.stringify(r.text.slice(0, 60)));
        return true;
    } catch (e) {
        log('generateText (não-streaming)', false, String(e.message).slice(0, 160));
        return false;
    }
}

// ── 3: streamText + tool calling multi-step (o que o finder realmente faz) ──
async function testToolCalling() {
    try {
        const r = streamText({
            model,
            providerOptions: { openai: { store: false } },
            system: SYSTEM,
            tools,
            stopWhen: (s) => (s.steps?.length ?? 0) >= 4,
            messages: [
                {
                    role: 'user',
                    content:
                        'Investigue se src/config.ts lê process.env diretamente. ' +
                        'Use grep e depois readFile antes de concluir.',
                },
            ],
        });

        const calls = [];
        for await (const part of r.fullStream) {
            if (part.type === 'tool-call') calls.push(part.toolName);
            if (part.type === 'error') throw new Error(JSON.stringify(part.error).slice(0, 200));
        }
        const text = await r.text;
        const usage = await r.usage;

        log('streamText + tool calling', calls.length > 0,
            `tools chamadas: [${calls.join(', ')}]`);
        log('system prompt próprio respeitado', text.includes('KODUS_OK'),
            JSON.stringify(text.slice(0, 80)));
        console.log('   usage:', JSON.stringify(usage));
        return calls.length > 0;
    } catch (e) {
        log('streamText + tool calling', false, String(e.message).slice(0, 200));
        return false;
    }
}

console.log(`\n=== PoC Codex/assinatura · modelo=${MODEL} ===\n`);
const a = await testGenerateText();
const b = await testToolCalling();

console.log('\n=== VEREDITO ===');
console.log(a
    ? 'generateText funciona -> encaixa direto no ai-sdk-agent-runner sem mudar o runner.'
    : 'generateText NÃO funciona -> runner precisa migrar para streamText, ou precisa de shim.');
console.log(b
    ? 'tool calling funciona -> o finder pode rodar por este caminho.'
    : 'tool calling NÃO funciona -> caminho inviável para o bench.');

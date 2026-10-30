/**
 * Provider ChatGPT/Codex por assinatura — seam isolado.
 *
 * O endpoint `chatgpt.com/backend-api/codex/responses` (autenticado com o token
 * OAuth do Codex CLI, não com API key) impõe duas regras que o resto do stack
 * não cumpre:
 *
 *   - `stream` DEVE ser true   → mas `ai-sdk-agent-runner` chama `generateText`
 *   - `store` DEVE ser false   → o AI SDK manda `store` por padrão
 *
 * Migrar o runner para `streamText` mexeria no caminho de TODOS os modelos por
 * causa de um só. Em vez disso, este wrapper implementa `doGenerate` consumindo
 * o próprio `doStream` e remontando o resultado — de fora, é um LanguageModel
 * não-streaming comum, e `generateText` funciona sem alteração no runner.
 *
 * NOTA DE METODOLOGIA: rodar por assinatura coloca esses modelos num regime de
 * cota diferente dos demais (que rodam por API, com rate limit ITPM). Qualquer
 * resultado publicado que misture os dois caminhos precisa declarar isso.
 */
import { createOpenAI } from '@ai-sdk/openai';
import fs from 'node:fs';
import os from 'node:os';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

type CodexAuth = { token: string; accountId: string };

/** Lê o token OAuth gravado por `codex login`. */
export function readCodexAuth(
    authPath = `${os.homedir()}/.codex/auth.json`,
): CodexAuth {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const token = raw?.tokens?.access_token;
    const accountId = raw?.tokens?.account_id;
    if (!token || !accountId) {
        throw new Error(
            `codex auth incompleto em ${authPath} — rode \`codex login\` (auth_mode=${raw?.auth_mode})`,
        );
    }
    return { token, accountId };
}

/**
 * Envolve um LanguageModel streaming-only para que `doGenerate` funcione,
 * drenando `doStream` e remontando content/usage/finishReason.
 */
function withGenerateFromStream(model: any): any {
    // `store: false` é obrigatório neste endpoint (400 "Store must be set to
    // false"). Injetamos aqui em vez de pedir ao chamador porque o runner não
    // conhece esse provider — assim o modelo é drop-in em qualquer caminho.
    // `store: false` e obrigatorio neste endpoint (400 "Store must be set to
    // false"). RECALL_REASONING_EFFORT sobrescreve o effort — o default do
    // backend do Codex e `medium`, inclusive para os modelos de topo, o que
    // subavalia sistematicamente quem foi desenhado para raciocinar mais.
    const effort = process.env.RECALL_REASONING_EFFORT;
    const withStore = (options: any) => ({
        ...options,
        providerOptions: {
            ...(options?.providerOptions || {}),
            openai: {
                ...(options?.providerOptions?.openai || {}),
                store: false,
                ...(effort ? { reasoningEffort: effort } : {}),
                // RETAINED REASONING. Com `store: false` e sem encrypted_content,
                // o @ai-sdk/openai DESCARTA os blocos de reasoning entre steps
                // (dist/index.js:4169 — "Reasoning parts without encrypted content
                // are not supported when store is false. Skipping reasoning parts").
                // Num loop de 30-60 tool calls isso faz o modelo re-derivar tudo a
                // cada passo. O SDK so pede esse include automaticamente para
                // modelos de reasoning que ele reconhece, e os servidos pelo
                // backend do Codex nao estao na lista — entao pedimos explicito.
                ...(process.env.RECALL_NO_RETAINED_REASONING === '1'
                    ? {}
                    : { include: ['reasoning.encrypted_content'] }),
            },
        },
    });

    return new Proxy(model, {
        get(target, prop, receiver) {
            if (prop === 'doStream') {
                return async (options: any) => target.doStream(withStore(options));
            }
            if (prop !== 'doGenerate') {
                return Reflect.get(target, prop, receiver);
            }
            return async (options: any) => {
                const { stream } = await target.doStream(withStore(options));

                const content: any[] = [];
                const textByFragment = new Map<string, string>();
                let finishReason = 'stop';
                let usage: any = {};
                let responseMetadata: any = {};
                const warnings: any[] = [];

                const reader = stream.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    switch (value.type) {
                        case 'text-delta': {
                            const id = value.id ?? '0';
                            textByFragment.set(
                                id,
                                (textByFragment.get(id) ?? '') + (value.delta ?? ''),
                            );
                            break;
                        }
                        case 'reasoning-delta': {
                            const id = `reasoning:${value.id ?? '0'}`;
                            textByFragment.set(
                                id,
                                (textByFragment.get(id) ?? '') + (value.delta ?? ''),
                            );
                            break;
                        }
                        case 'tool-call':
                            content.push({ ...value, type: 'tool-call' });
                            break;
                        case 'file':
                        case 'source':
                            content.push(value);
                            break;
                        case 'finish':
                            finishReason = value.finishReason ?? finishReason;
                            usage = value.usage ?? usage;
                            break;
                        case 'response-metadata':
                            responseMetadata = { ...responseMetadata, ...value };
                            break;
                        case 'stream-start':
                            if (Array.isArray(value.warnings)) warnings.push(...value.warnings);
                            break;
                        case 'error':
                            throw value.error instanceof Error
                                ? value.error
                                : new Error(JSON.stringify(value.error));
                    }
                }

                // Texto primeiro (o runner lê content[0] como resposta), raciocínio depois.
                for (const [id, text] of textByFragment) {
                    if (!text) continue;
                    content.unshift(
                        id.startsWith('reasoning:')
                            ? { type: 'reasoning', text }
                            : { type: 'text', text },
                    );
                }

                return {
                    content,
                    finishReason,
                    usage,
                    warnings,
                    response: responseMetadata,
                };
            };
        },
    });
}

/**
 * Constrói um modelo servido pela assinatura ChatGPT.
 * Uso: `buildCodexSubscriptionModel('gpt-5.6-luna')` no lugar do provider de API.
 */
export function buildCodexSubscriptionModel(
    modelId: string,
    auth: CodexAuth = readCodexAuth(),
): any {
    const provider = createOpenAI({
        apiKey: auth.token,
        baseURL: CODEX_BASE_URL,
        headers: {
            'chatgpt-account-id': auth.accountId,
            'OpenAI-Beta': 'responses=experimental',
            originator: 'codex_cli_rs',
        },
    });
    return withGenerateFromStream(provider.responses(modelId));
}

/** `store: false` é obrigatório neste endpoint — injete junto de toda chamada. */
export const CODEX_PROVIDER_OPTIONS = { openai: { store: false } } as const;

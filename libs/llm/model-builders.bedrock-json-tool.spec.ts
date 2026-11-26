/**
 * Bedrock's forced `json` tool, through the real `@ai-sdk/amazon-bedrock` and
 * a stubbed Converse body: the answer is the text part that IS the tool input,
 * read from the body, never the model's own text around it. When the body
 * holds two json tool calls, which one answers cannot be told and the result
 * is left as the SDK made it (the call fails, as before the middleware).
 */
import { bedrockModelFromCredentials } from './model-builders';

jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
}));

const realFetch = global.fetch;
let body: unknown;

beforeEach(() => {
    global.fetch = jest.fn(async () =>
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
});

afterEach(() => {
    global.fetch = realFetch;
});

const converse = (...content: unknown[]) => ({
    output: { message: { role: 'assistant', content } },
    stopReason: 'tool_use',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
const toolUse = (input: unknown, id = 't1') => ({
    toolUse: { toolUseId: id, name: 'json', input },
});

async function answerText(): Promise<string[]> {
    const model: any = bedrockModelFromCredentials(
        { awsBearerToken: 'key', awsRegion: 'us-east-1' } as any,
        'moonshotai.kimi-k2.5',
    );
    const out = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'review' }] }],
        responseFormat: {
            type: 'json',
            schema: {
                type: 'object',
                properties: { violations: { type: 'array' } },
                required: ['violations'],
            },
        },
    });
    return out.content.filter((p: any) => p.type === 'text').map((p: any) => p.text);
}

const findings = { violations: [{ body: 'bug', line: 12 }] };

describe('Bedrock json tool: the answer is the tool input read from the body', () => {
    it('drops the model prose and its own example before the tool call (production shape)', async () => {
        body = converse(
            { text: 'If nothing is wrong I would return {"violations":[]}.' },
            { text: '{"violations":[]}' },
            toolUse(findings),
        );
        await expect(answerText()).resolves.toEqual([JSON.stringify(findings)]);
    });

    it('a JSON text after the tool block does not replace the tool input', async () => {
        body = converse(toolUse(findings), { text: '{"violations":[]}' });
        await expect(answerText()).resolves.toEqual([JSON.stringify(findings)]);
    });

    it('a bare value after the tool block does not replace the tool input', async () => {
        body = converse(toolUse(findings), { text: '1' });
        await expect(answerText()).resolves.toEqual([JSON.stringify(findings)]);
    });

    it('two json tool calls in one turn are left as they came (ambiguous)', async () => {
        body = converse(toolUse(findings, 't1'), toolUse({ violations: [] }, 't2'));
        await expect(answerText()).resolves.toEqual([
            JSON.stringify(findings),
            JSON.stringify({ violations: [] }),
        ]);
    });
});

import { applyOneShotCache, resolvePrefixCacheHint } from './one-shot-cache';

const ANTHROPIC = { anthropic: { cacheControl: { type: 'ephemeral' } } };
const BEDROCK = { bedrock: { cachePoint: { type: 'default' } } };
const OPENAI_PART = { openai: { promptCacheBreakpoint: { mode: 'explicit' } } };
const OPENAI_REQUEST = { openai: { promptCacheOptions: { mode: 'explicit' } } };

describe('resolvePrefixCacheHint', () => {
    it('marks native Claude with the Anthropic ephemeral marker', () => {
        expect(
            resolvePrefixCacheHint({
                provider: 'anthropic',
                model: 'claude-sonnet-5-5',
            }),
        ).toEqual({ part: ANTHROPIC });
    });

    it('marks Claude on Bedrock with a cachePoint, and nothing else on Bedrock', () => {
        expect(
            resolvePrefixCacheHint({
                provider: 'amazon_bedrock',
                model: 'eu.anthropic.claude-sonnet-5-5',
            }),
        ).toEqual({ part: BEDROCK });
        expect(
            resolvePrefixCacheHint({
                provider: 'amazon_bedrock',
                model: 'amazon.nova-pro-v1:0',
            }),
        ).toBeUndefined();
    });

    it('marks Claude on Vertex, not Gemini on Vertex', () => {
        expect(
            resolvePrefixCacheHint({
                provider: 'google_vertex',
                model: 'claude-sonnet-5-5',
            }),
        ).toEqual({ part: ANTHROPIC });
        expect(
            resolvePrefixCacheHint({
                provider: 'google_vertex',
                model: 'gemini-3.8-flash',
            }),
        ).toBeUndefined();
    });

    it.each(['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6.1-sol'])(
        'marks OpenAI %s with an explicit breakpoint and explicit mode for the request',
        (model) => {
            expect(
                resolvePrefixCacheHint({ provider: 'openai', model }),
            ).toEqual({
                part: OPENAI_PART,
                request: OPENAI_REQUEST,
            });
            expect(
                resolvePrefixCacheHint({
                    provider: 'openai',
                    model,
                    baseURL: 'https://api.openai.com/v1',
                }),
            ).toEqual({ part: OPENAI_PART, request: OPENAI_REQUEST });
        },
    );

    it.each(['gpt-5.5', 'gpt-5.4-mini', 'gpt-4o', 'o3'])(
        'leaves OpenAI %s on implicit caching',
        (model) => {
            expect(
                resolvePrefixCacheHint({ provider: 'openai', model }),
            ).toBeUndefined();
        },
    );

    it('leaves OpenAI models behind another host (Azure, a gateway) unmarked', () => {
        expect(
            resolvePrefixCacheHint({
                provider: 'openai',
                model: 'gpt-6.1-sol',
                baseURL: 'https://acme.openai.azure.com/openai/v1/',
            }),
        ).toBeUndefined();
        expect(
            resolvePrefixCacheHint({
                provider: 'openai',
                model: 'gpt-6.1-sol',
                baseURL: 'https://litellm.example.com/v1',
            }),
        ).toBeUndefined();
    });

    it.each([
        ['google_gemini', 'gemini-3.8-flash'],
        ['open_router', 'anthropic/claude-sonnet-5.5'],
        ['openai_compatible', 'deepseek-v4.1-flash'],
    ])('leaves %s unmarked', (provider, model) => {
        expect(resolvePrefixCacheHint({ provider, model })).toBeUndefined();
    });

    it('falls back on the model name when there is no slot (managed default)', () => {
        expect(resolvePrefixCacheHint({ model: 'claude-sonnet-5-5' })).toEqual({
            part: ANTHROPIC,
        });
        expect(
            resolvePrefixCacheHint({ model: 'kimi-k2.7-code' }),
        ).toBeUndefined();
    });
});

describe('applyOneShotCache', () => {
    const system = 'You check rules.';
    const head = '<Rules>\n[1] no console\n</Rules>\n';
    const tail = '<File path="a.ts">\n+console.log(1)\n</File>';
    const prompt = head + tail;

    it('changes nothing when the call asks for no cache', () => {
        const providerOptions = {
            anthropic: { thinking: { type: 'adaptive' } },
        };
        const out = applyOneShotCache({
            system,
            prompt,
            hint: { part: ANTHROPIC },
            providerOptions,
        });
        expect(out.args).toEqual({ system, prompt });
        expect(out.providerOptions).toBe(providerOptions);
        expect(out.marked).toEqual([]);
        expect(out.droppedAutoCache).toBe(false);
    });

    it('changes nothing when the provider takes no marker', () => {
        const out = applyOneShotCache({
            system,
            prompt,
            cache: { userPrefixes: [head], system: true },
            hint: undefined,
        });
        expect(out.args).toEqual({ system, prompt });
        expect(out.marked).toEqual([]);
    });

    it('splits the user turn after the shared head and marks the head', () => {
        const out = applyOneShotCache({
            system,
            prompt,
            cache: { userPrefixes: [head] },
            hint: { part: BEDROCK },
        });
        expect(out.args).toEqual({
            system,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: head, providerOptions: BEDROCK },
                        { type: 'text', text: tail },
                    ],
                },
            ],
        });
        expect(out.marked).toEqual(['userPrefix']);
    });

    it('marks each nested prefix of the user turn, shortest first', () => {
        const rules = '<Rules>\n[1] no console\n</Rules>\n';
        const headWithIntent = `${rules}<PR title="x">\n</PR>\n`;
        const turn = `${headWithIntent}${tail}`;
        const out = applyOneShotCache({
            system,
            prompt: turn,
            cache: { userPrefixes: [headWithIntent, rules] },
            hint: { part: ANTHROPIC },
        });
        expect(out.args.messages?.[0].content).toEqual([
            { type: 'text', text: rules, providerOptions: ANTHROPIC },
            {
                type: 'text',
                text: '<PR title="x">\n</PR>\n',
                providerOptions: ANTHROPIC,
            },
            { type: 'text', text: tail },
        ]);
        expect(out.marked).toEqual(['userPrefix']);
        expect(out.userBreakpoints).toBe(2);
    });

    it('marks the prefixes the turn starts with and skips the others', () => {
        const rules = '<Rules>\n[1] no console\n</Rules>\n';
        const out = applyOneShotCache({
            system,
            prompt: `${rules}${tail}`,
            cache: { userPrefixes: [rules, `${rules}<PR title="y">`, ''] },
            hint: { part: BEDROCK },
        });
        expect(out.args.messages?.[0].content).toEqual([
            { type: 'text', text: rules, providerOptions: BEDROCK },
            { type: 'text', text: tail },
        ]);
        expect(out.userBreakpoints).toBe(1);
        expect(out.skipped).toBe('prefix-mismatch');
    });

    it('marks a repeated prefix once', () => {
        const out = applyOneShotCache({
            system,
            prompt,
            cache: { userPrefixes: [head, head] },
            hint: { part: ANTHROPIC },
        });
        expect(out.args.messages?.[0].content).toHaveLength(2);
        expect(out.userBreakpoints).toBe(1);
    });

    it('never sends more than four breakpoints, the system prompt included', () => {
        const parts = ['a', 'ab', 'abc', 'abcd', 'abcde'];
        const out = applyOneShotCache({
            system,
            prompt: 'abcdef',
            cache: { system: true, userPrefixes: parts },
            hint: { part: ANTHROPIC },
        });
        const content = out.args.messages?.[0].content as Array<{
            text: string;
            providerOptions?: unknown;
        }>;
        expect(content.filter((p) => p.providerOptions)).toHaveLength(3);
        expect(content.map((p) => p.text).join('')).toBe('abcdef');
        // The longest prefixes are the ones kept: they cover the most.
        expect(content[content.length - 1].text).toBe('f');
        expect(out.userBreakpoints).toBe(3);
    });

    it('sends the same text, only split', () => {
        const out = applyOneShotCache({
            system,
            prompt,
            cache: { userPrefixes: [head] },
            hint: { part: ANTHROPIC },
        });
        const parts = (out.args.messages?.[0].content ?? []) as Array<{
            text: string;
        }>;
        expect(parts.map((p) => p.text).join('')).toBe(prompt);
    });

    it('keeps one marked part when the head is the whole turn', () => {
        const out = applyOneShotCache({
            system,
            prompt: head,
            cache: { userPrefixes: [head] },
            hint: { part: ANTHROPIC },
        });
        expect(out.args.messages?.[0].content).toEqual([
            { type: 'text', text: head, providerOptions: ANTHROPIC },
        ]);
    });

    it('does not mark a head the turn does not start with', () => {
        const out = applyOneShotCache({
            system,
            prompt: `prefix-moved\n${prompt}`,
            cache: { userPrefixes: [head] },
            hint: { part: ANTHROPIC },
        });
        expect(out.args).toEqual({ system, prompt: `prefix-moved\n${prompt}` });
        expect(out.marked).toEqual([]);
        expect(out.skipped).toBe('prefix-mismatch');
    });

    it('marks the system prompt when asked', () => {
        const out = applyOneShotCache({
            system,
            prompt,
            cache: { system: true },
            hint: { part: ANTHROPIC },
        });
        expect(out.args).toEqual({
            system: {
                role: 'system',
                content: system,
                providerOptions: ANTHROPIC,
            },
            prompt,
        });
        expect(out.marked).toEqual(['system']);
    });

    it('does not mark an empty or missing system prompt', () => {
        const out = applyOneShotCache({
            system: undefined,
            prompt,
            cache: { system: true },
            hint: { part: ANTHROPIC },
        });
        expect(out.args).toEqual({ system: undefined, prompt });
        expect(out.marked).toEqual([]);
    });

    it('merges request-level options into the call options, per vendor', () => {
        const out = applyOneShotCache({
            system,
            prompt,
            cache: { userPrefixes: [head] },
            hint: { part: OPENAI_PART, request: OPENAI_REQUEST },
            providerOptions: {
                openai: { store: false, reasoningEffort: 'low' },
            },
        });
        expect(out.providerOptions).toEqual({
            openai: {
                store: false,
                reasoningEffort: 'low',
                promptCacheOptions: { mode: 'explicit' },
            },
        });
    });

    it('leaves request options alone when nothing was marked', () => {
        const providerOptions = { openai: { store: false } };
        const out = applyOneShotCache({
            system,
            prompt: 'no head here',
            cache: { userPrefixes: [head] },
            hint: { part: OPENAI_PART, request: OPENAI_REQUEST },
            providerOptions,
        });
        expect(out.args).toEqual({ system, prompt: 'no head here' });
        expect(out.marked).toEqual([]);
        expect(out.providerOptions).toBe(providerOptions);
    });

    it('leaves request options alone on a call that declares no cache', () => {
        const providerOptions = { openai: { store: false } };
        const out = applyOneShotCache({
            system,
            prompt,
            hint: { part: OPENAI_PART, request: OPENAI_REQUEST },
            providerOptions,
        });
        expect(out.providerOptions).toBe(providerOptions);
    });

    it('drops an automatic Anthropic cacheControl from the call options on a marked call', () => {
        const out = applyOneShotCache({
            system,
            prompt,
            cache: { userPrefixes: [head] },
            hint: { part: ANTHROPIC },
            providerOptions: {
                anthropic: {
                    cacheControl: { type: 'ephemeral' },
                    thinking: { type: 'adaptive' },
                },
            },
        });
        expect(out.providerOptions).toEqual({
            anthropic: { thinking: { type: 'adaptive' } },
        });
        expect(out.droppedAutoCache).toBe(true);
    });

    it('drops the snake_case spelling too', () => {
        const out = applyOneShotCache({
            system,
            prompt,
            cache: { system: true },
            hint: { part: ANTHROPIC },
            providerOptions: {
                anthropic: { cache_control: { type: 'ephemeral' } },
            },
        });
        expect(out.providerOptions).toEqual({ anthropic: {} });
        expect(out.droppedAutoCache).toBe(true);
    });

    it('sends a call with nothing to mark as if it declared nothing, automatic cache included', () => {
        const providerOptions = {
            anthropic: { cacheControl: { type: 'ephemeral' } },
        };
        const out = applyOneShotCache({
            system,
            prompt,
            cache: { userPrefixes: [] },
            hint: { part: ANTHROPIC },
            providerOptions,
        });
        expect(out.args).toEqual({ system, prompt });
        expect(out.marked).toEqual([]);
        expect(out.providerOptions).toBe(providerOptions);
        expect(out.droppedAutoCache).toBe(false);
    });

    it('keeps an automatic cacheControl on a call that declares no cache', () => {
        const providerOptions = {
            anthropic: { cacheControl: { type: 'ephemeral' } },
        };
        const out = applyOneShotCache({
            system,
            prompt,
            providerOptions,
            hint: { part: ANTHROPIC },
        });
        expect(out.providerOptions).toBe(providerOptions);
        expect(out.droppedAutoCache).toBe(false);
    });
});

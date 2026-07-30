import { MessageTemplateProcessor } from './messageTemplateProcessor.service';

describe('MessageTemplateProcessor', () => {
    let processor: MessageTemplateProcessor;

    beforeEach(() => {
        processor = new MessageTemplateProcessor();
    });

    describe('processTemplate', () => {
        it('returns the template unchanged when there are no placeholders', async () => {
            const result = await processor.processTemplate(
                'Olá! Bem-vindo ao seu PR review.',
                {},
            );
            expect(result).toBe('Olá! Bem-vindo ao seu PR review.');
        });

        it('preserves arbitrary user content with a recognized placeholder appended', async () => {
            const result = await processor.processTemplate(
                'Custom intro line.\n\n@changedFiles',
                {
                    changedFiles: [
                        {
                            filename: 'src/foo.ts',
                            blob_url: 'https://github.com/x/y/blob/main/src/foo.ts',
                            status: 'modified',
                            additions: 10,
                            deletions: 2,
                            changes: 12,
                        } as any,
                    ],
                    language: 'en-US',
                },
            );
            expect(result.startsWith('Custom intro line.\n\n')).toBe(true);
            expect(result).toContain('src/foo.ts');
            expect(result).toContain('<details>');
            expect(result).not.toContain('@changedFiles');
        });

        it('leaves unknown placeholders untouched (no handler = no replacement)', async () => {
            const result = await processor.processTemplate(
                'Hi @notARealPlaceholder bye',
                {},
            );
            expect(result).toBe('Hi @notARealPlaceholder bye');
        });

        it('handles multiple distinct placeholders in the same template', async () => {
            const changedFiles = [
                {
                    filename: 'a.ts',
                    blob_url: 'https://x/a.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 1,
                    changes: 6,
                } as any,
                {
                    filename: 'b.ts',
                    blob_url: 'https://x/b.ts',
                    status: 'added',
                    additions: 20,
                    deletions: 0,
                    changes: 20,
                } as any,
            ];
            const result = await processor.processTemplate(
                '@changedFiles\n\n@changeSummary',
                { changedFiles, language: 'en-US' },
            );
            expect(result).toContain('a.ts');
            expect(result).toContain('b.ts');
            // Summary block contains totals
            expect(result).toContain('25'); // total additions = 5 + 20
            expect(result).toContain('1'); // total deletions = 1 + 0
        });

        it('returns empty content from @changedFiles when there are no files', async () => {
            const result = await processor.processTemplate(
                'Body @changedFiles tail',
                { changedFiles: [], language: 'en-US' },
            );
            // @changedFiles replaced by empty string
            expect(result).toBe('Body  tail');
        });

        it('processes the same placeholder repeatedly only once (regex matchAll captures all)', async () => {
            // The current implementation replaces every match of the same placeholder
            // with the same content. This guards against accidental "replace once" change.
            const result = await processor.processTemplate(
                '@changedFiles AND @changedFiles',
                {
                    changedFiles: [
                        {
                            filename: 'only.ts',
                            blob_url: 'u',
                            status: 'modified',
                            additions: 1,
                            deletions: 0,
                            changes: 1,
                        } as any,
                    ],
                    language: 'en-US',
                },
            );
            const occurrences = (result.match(/only\.ts/g) || []).length;
            expect(occurrences).toBe(2);
            expect(result).not.toContain('@changedFiles');
        });
    });

    describe('handler registry', () => {
        it('exposes the default placeholders', () => {
            expect(new Set(processor.getAvailablePlaceholders())).toEqual(
                new Set([
                    '@changedFiles',
                    '@changeSummary',
                    '@reviewOptions',
                    '@reviewCadence',
                    '@reviewScope',
                    '@agentPrompt',
                ]),
            );
        });

        it('resolves the deprecated @consolidatedLLMPrompt alias without advertising it', async () => {
            // Renamed to @agentPrompt, but saved templates may still use the old
            // name — it must render the same block, not the literal placeholder.
            expect(processor.getAvailablePlaceholders()).not.toContain(
                '@consolidatedLLMPrompt',
            );

            const viaAlias = await processor.processTemplate(
                '@consolidatedLLMPrompt',
                { lineComments: [] },
            );
            const viaCurrent = await processor.processTemplate('@agentPrompt', {
                lineComments: [],
            });

            expect(viaAlias).not.toContain('@consolidatedLLMPrompt');
            expect(viaAlias).toBe(viaCurrent);
        });

        it('does not route unknown placeholders through an empty-string handler', async () => {
            // Guards the alias fallback: an empty-key handler must not become
            // reachable for every unrecognized placeholder.
            processor.registerHandler('', () => '__EMPTY__');

            const result = await processor.processTemplate(
                'Hi @notARealPlaceholder bye',
                {},
            );

            expect(result).toBe('Hi @notARealPlaceholder bye');
            expect(result).not.toContain('__EMPTY__');
        });

        it('lets callers register a custom placeholder handler', async () => {
            processor.registerHandler('greeting', () => 'Hello, world!');

            const result = await processor.processTemplate('@greeting', {});

            expect(result).toBe('Hello, world!');
            expect(processor.getAvailablePlaceholders()).toContain('@greeting');
        });

        it('supports async custom handlers', async () => {
            processor.registerHandler(
                'asyncOne',
                async () => 'resolved value',
            );

            const result = await processor.processTemplate(
                'X: @asyncOne',
                {},
            );

            expect(result).toBe('X: resolved value');
        });

        it('overrides an existing default handler when registered with the same name', async () => {
            processor.registerHandler(
                'changedFiles',
                () => '__OVERRIDDEN__',
            );

            const result = await processor.processTemplate(
                '@changedFiles',
                { changedFiles: [], language: 'en-US' },
            );

            expect(result).toBe('__OVERRIDDEN__');
        });
    });

    describe('agent prompt (@agentPrompt)', () => {
        const makeLineComment = (
            suggestion: Record<string, unknown>,
            over: Record<string, unknown> = {},
        ) =>
            ({
                comment: {
                    path: 'src/foo.ts',
                    line: 8,
                    body: {},
                    suggestion,
                    ...over,
                },
                deliveryStatus: 'sent',
            }) as any;

        it('returns empty for an empty comment list', () => {
            expect(processor.getConsolidatedLLMPromptBody([])).toBe('');
        });

        it('returns empty when no comment carries an llmPrompt', () => {
            const body = processor.getConsolidatedLLMPromptBody([
                makeLineComment({ suggestionContent: 'x', improvedCode: '' }),
            ]);
            expect(body).toBe('');
        });

        it('builds a block with the file list and one section per issue', () => {
            const body = processor.getConsolidatedLLMPromptBody([
                makeLineComment(
                    { llmPrompt: 'Fix the null deref', improvedCode: '' },
                    { path: 'src/a.ts', line: 3 },
                ),
                makeLineComment(
                    { llmPrompt: 'Guard the index', improvedCode: '' },
                    { path: 'src/b.ts', line: 9 },
                ),
            ]);
            expect(body).toContain('2 suggested fixes');
            expect(body).toContain('- src/a.ts:3');
            expect(body).toContain('- src/b.ts:9');
            expect(body).toContain('[1/2] src/a.ts:3');
            expect(body).toContain('Fix the null deref');
            expect(body).toContain('[2/2] src/b.ts:9');
            expect(body).toContain('Guard the index');
        });

        it('omits the :line suffix when the comment has no line number', () => {
            const body = processor.getConsolidatedLLMPromptBody([
                makeLineComment(
                    { llmPrompt: 'File-level finding', improvedCode: '' },
                    { path: 'src/c.ts', line: undefined },
                ),
            ]);
            expect(body).toContain('- src/c.ts');
            expect(body).not.toContain('src/c.ts:');
            expect(body).toContain('[1/1] src/c.ts');
        });

        it('includes improvedCode as a reference implementation when present', () => {
            const body = processor.getConsolidatedLLMPromptBody([
                makeLineComment({
                    llmPrompt: 'Rename the variable',
                    improvedCode: 'const total = a + b;',
                }),
            ]);
            expect(body).toContain('Reference implementation');
            expect(body).toContain('const total = a + b;');
        });

        it('wraps the block in a fence longer than any backtick run inside it', () => {
            // improvedCode carrying its own ``` fence must NOT close the outer
            // block early — the outer fence has to grow past the inner run.
            const body = processor.getConsolidatedLLMPromptBody([
                makeLineComment({
                    llmPrompt: 'See the fenced snippet',
                    improvedCode: '```ts\nconst x = 1;\n```',
                }),
            ]);
            expect(body).toMatch(/`{4,}/); // outer fence bumped to >=4 backticks
            expect(body).toContain('```ts'); // inner 3-backtick fence preserved
        });

        it('renders through the @agentPrompt placeholder', async () => {
            const result = await processor.processTemplate(
                'Summary:\n\n@agentPrompt',
                {
                    lineComments: [
                        makeLineComment({
                            llmPrompt: 'Fix it',
                            improvedCode: '',
                        }),
                    ],
                },
            );
            expect(result).toContain('Summary:');
            expect(result).not.toContain('@agentPrompt');
            expect(result).toContain('Fix it');
        });
    });
});

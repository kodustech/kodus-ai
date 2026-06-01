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
                ]),
            );
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
});

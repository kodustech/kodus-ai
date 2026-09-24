/**
 * Mutation-killing tests for the Tiptap JSON conversion utilities.
 *
 * Both functions are pure and dependency-free, so they are imported and
 * called directly. Every assertion pins EXACT output so that a plausible
 * regression (wrong separator, dropped default, flipped mark order,
 * off-by-one list index, removed newline-collapse, etc.) makes a test fail.
 */

import {
    convertTiptapJSONToMarkdown,
    convertTiptapJSONToText,
} from './tiptap-json-to-text';

describe('convertTiptapJSONToText', () => {
    describe('null / undefined / falsy guards', () => {
        it('returns empty string for null', () => {
            expect(convertTiptapJSONToText(null)).toBe('');
        });

        it('returns empty string for undefined', () => {
            expect(convertTiptapJSONToText(undefined)).toBe('');
        });

        it('returns empty string for empty string (falsy guard)', () => {
            expect(convertTiptapJSONToText('')).toBe('');
        });

        it('returns empty string for a non-string, non-object value', () => {
            // Truthy number: skips the `!content`, string and object branches,
            // hitting the final `return ""`.
            expect(convertTiptapJSONToText(5 as any)).toBe('');
        });
    });

    describe('string inputs', () => {
        it('returns a plain (non-JSON) string as-is', () => {
            expect(convertTiptapJSONToText('hello world')).toBe('hello world');
        });

        it('parses a JSON string and converts it', () => {
            const json = '{"type":"text","text":"hi"}';
            expect(convertTiptapJSONToText(json)).toBe('hi');
        });

        it('returns the raw string when it starts with { but is invalid JSON', () => {
            // Both `startsWith("{")` conditions are true, JSON.parse throws,
            // catch returns the original string.
            expect(convertTiptapJSONToText('{not valid json')).toBe(
                '{not valid json',
            );
        });

        it('treats a leading-whitespace JSON string as a plain string (kills && -> ||)', () => {
            // content.startsWith("{") is FALSE for "  {...}", so the whole
            // condition is false and the string is returned verbatim. An
            // `||` mutant would parse it and return "".
            const withLeadingSpace = '  {"type":"text","text":"hi"}';
            expect(convertTiptapJSONToText(withLeadingSpace)).toBe(
                withLeadingSpace,
            );
        });
    });

    describe('object traversal', () => {
        it('concatenates text and mcpMention tokens in order', () => {
            const doc = {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: 'Hello ' },
                            {
                                type: 'mcpMention',
                                attrs: {
                                    app: 'kodus',
                                    tool: 'kodus_list_commits',
                                },
                            },
                            { type: 'text', text: ' world' },
                        ],
                    },
                ],
            };
            expect(convertTiptapJSONToText(doc)).toBe(
                'Hello @mcp<kodus|kodus_list_commits> world',
            );
        });

        it('defaults missing mcpMention app and tool to empty strings', () => {
            const doc = { type: 'mcpMention', attrs: {} };
            expect(convertTiptapJSONToText(doc)).toBe('@mcp<|>');
        });

        it('keeps a supplied tool while defaulting a missing app', () => {
            const doc = { type: 'mcpMention', attrs: { tool: 't' } };
            expect(convertTiptapJSONToText(doc)).toBe('@mcp<|t>');
        });

        it('defaults a missing text node value to empty string', () => {
            const doc = {
                type: 'paragraph',
                content: [{ type: 'text' }, { type: 'text', text: 'kept' }],
            };
            expect(convertTiptapJSONToText(doc)).toBe('kept');
        });

        it('returns empty string when traversal throws (fail-safe catch)', () => {
            const bad = {};
            Object.defineProperty(bad, 'type', {
                get() {
                    throw new Error('boom');
                },
            });
            const doc = { type: 'doc', content: [bad] };
            expect(convertTiptapJSONToText(doc)).toBe('');
        });
    });
});

describe('convertTiptapJSONToMarkdown', () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
    });

    afterEach(() => {
        errorSpy.mockRestore();
    });

    const para = (text: string, marks?: any[]) => ({
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
            },
        ],
    });

    describe('string / falsy guards', () => {
        it('returns empty string for null', () => {
            expect(convertTiptapJSONToMarkdown(null)).toBe('');
        });

        it('returns a plain string as-is', () => {
            expect(convertTiptapJSONToMarkdown('just text')).toBe('just text');
        });

        it('parses a JSON string and converts it', () => {
            const json =
                '{"type":"paragraph","content":[{"type":"text","text":"hi"}]}';
            expect(convertTiptapJSONToMarkdown(json)).toBe('hi');
        });

        it('returns the raw string when it starts with { but is invalid JSON', () => {
            expect(convertTiptapJSONToMarkdown('{broken')).toBe('{broken');
        });

        it('treats a leading-whitespace JSON string as plain (kills && -> ||)', () => {
            const s = '  {"type":"paragraph"}';
            expect(convertTiptapJSONToMarkdown(s)).toBe(s);
        });

        it('returns empty string for a truthy non-object, non-string value', () => {
            expect(convertTiptapJSONToMarkdown(7 as any)).toBe('');
        });
    });

    describe('text marks', () => {
        it('wraps bold text with double asterisks', () => {
            expect(
                convertTiptapJSONToMarkdown(para('x', [{ type: 'bold' }])),
            ).toBe('**x**');
        });

        it('wraps italic text with single asterisks', () => {
            expect(
                convertTiptapJSONToMarkdown(para('x', [{ type: 'italic' }])),
            ).toBe('*x*');
        });

        it('wraps code text with backticks', () => {
            expect(
                convertTiptapJSONToMarkdown(para('x', [{ type: 'code' }])),
            ).toBe('`x`');
        });

        it('wraps strike text with double tildes', () => {
            expect(
                convertTiptapJSONToMarkdown(para('x', [{ type: 'strike' }])),
            ).toBe('~~x~~');
        });

        it('formats a link with its href', () => {
            expect(
                convertTiptapJSONToMarkdown(
                    para('click', [
                        { type: 'link', attrs: { href: 'http://a.com' } },
                    ]),
                ),
            ).toBe('[click](http://a.com)');
        });

        it('defaults a missing link href to empty parentheses', () => {
            expect(
                convertTiptapJSONToMarkdown(para('click', [{ type: 'link' }])),
            ).toBe('[click]()');
        });

        it('leaves text untouched for an unknown mark type', () => {
            expect(
                convertTiptapJSONToMarkdown(para('y', [{ type: 'highlight' }])),
            ).toBe('y');
        });

        it('applies marks innermost-first (reversed order)', () => {
            // marks = [link, bold] -> reversed = [bold, link]:
            // bold wraps first ("**x**"), then link wraps that.
            // Forward order would instead yield "**[x](u)**".
            expect(
                convertTiptapJSONToMarkdown(
                    para('x', [
                        { type: 'link', attrs: { href: 'u' } },
                        { type: 'bold' },
                    ]),
                ),
            ).toBe('[**x**](u)');
        });
    });

    describe('mcp mentions', () => {
        it('renders an mcpMention token', () => {
            const doc = {
                type: 'paragraph',
                content: [
                    { type: 'mcpMention', attrs: { app: 'a', tool: 't' } },
                ],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('@mcp<a|t>');
        });

        it('defaults missing mcpMention attrs to empty strings', () => {
            const doc = {
                type: 'paragraph',
                content: [{ type: 'mcpMention' }],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('@mcp<|>');
        });
    });

    describe('headings', () => {
        it('defaults heading level to 1 (single hash)', () => {
            const doc = {
                type: 'heading',
                content: [{ type: 'text', text: 'Title' }],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('# Title');
        });

        it('uses the supplied heading level for the hash count', () => {
            const doc = {
                type: 'heading',
                attrs: { level: 3 },
                content: [{ type: 'text', text: 'Title' }],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('### Title');
        });
    });

    describe('paragraphs', () => {
        it('separates consecutive paragraphs with a blank line', () => {
            const doc = {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'A' }],
                    },
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'B' }],
                    },
                ],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('A\n\nB');
        });

        it('collapses 3+ consecutive newlines down to two', () => {
            // The empty middle paragraph injects an extra blank line, giving
            // four newlines between A and B; the /\n{3,}/ cleanup collapses
            // them back to exactly two.
            const doc = {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'A' }],
                    },
                    { type: 'paragraph' },
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'B' }],
                    },
                ],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('A\n\nB');
        });
    });

    describe('lists', () => {
        it('renders a bullet list with dash prefixes', () => {
            const doc = {
                type: 'doc',
                content: [
                    {
                        type: 'bulletList',
                        content: [
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [
                                            { type: 'text', text: 'one' },
                                        ],
                                    },
                                ],
                            },
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [
                                            { type: 'text', text: 'two' },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('- one\n- two');
        });

        it('adds a trailing blank line after a top-level bullet list', () => {
            // Content following the list proves the list emits its own
            // separating newline (double newline before "after").
            const doc = {
                type: 'doc',
                content: [
                    {
                        type: 'bulletList',
                        content: [
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [
                                            { type: 'text', text: 'one' },
                                        ],
                                    },
                                ],
                            },
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [
                                            { type: 'text', text: 'two' },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'after' }],
                    },
                ],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe(
                '- one\n- two\n\nafter',
            );
        });

        it('numbers an ordered list starting from the supplied start index', () => {
            const doc = {
                type: 'doc',
                content: [
                    {
                        type: 'orderedList',
                        attrs: { start: 3 },
                        content: [
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [{ type: 'text', text: 'a' }],
                                    },
                                ],
                            },
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [{ type: 'text', text: 'b' }],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('3. a\n4. b');
        });

        it('defaults the ordered list start index to 1', () => {
            const doc = {
                type: 'doc',
                content: [
                    {
                        type: 'orderedList',
                        content: [
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [{ type: 'text', text: 'a' }],
                                    },
                                ],
                            },
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [{ type: 'text', text: 'b' }],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('1. a\n2. b');
        });
    });

    describe('blockquotes', () => {
        it('prefixes quoted content with >', () => {
            const doc = {
                type: 'blockquote',
                content: [
                    {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'quote' }],
                    },
                ],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('> quote');
        });
    });

    describe('code blocks', () => {
        it('fences code with the supplied language', () => {
            const doc = {
                type: 'codeBlock',
                attrs: { language: 'ts' },
                content: [{ type: 'text', text: 'const x = 1' }],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe(
                '```ts\nconst x = 1\n```',
            );
        });

        it('defaults to an empty language when none is supplied', () => {
            const doc = {
                type: 'codeBlock',
                content: [{ type: 'text', text: 'code' }],
            };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('```\ncode\n```');
        });
    });

    describe('horizontal rule', () => {
        it('renders --- for a horizontal rule', () => {
            const doc = { type: 'doc', content: [{ type: 'horizontalRule' }] };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('---');
        });
    });

    describe('fail-safe', () => {
        it('returns empty string and logs when traversal throws', () => {
            const bad = {};
            Object.defineProperty(bad, 'type', {
                get() {
                    throw new Error('boom');
                },
            });
            const doc = { type: 'doc', content: [bad] };
            expect(convertTiptapJSONToMarkdown(doc)).toBe('');
            expect(errorSpy).toHaveBeenCalled();
        });
    });
});

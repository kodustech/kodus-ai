/**
 * Mutation-killing tests for the Tiptap JSON to text conversion.
 *
 * The function is pure and dependency-free, so it is imported and
 * called directly. Every assertion pins EXACT output so that a plausible
 * regression (wrong separator, dropped default, flipped mark order,
 * off-by-one list index, removed newline-collapse, etc.) makes a test fail.
 */

import { convertTiptapJSONToText } from './tiptap-json-to-text';

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

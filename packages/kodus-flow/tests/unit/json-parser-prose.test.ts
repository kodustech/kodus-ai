/**
 * @file json-parser-prose.test.ts
 * @description Regression tests for EnhancedJSONParser against prose-wrapped JSON.
 *
 * Root cause of the @kody conversation failure: when an LLM prefixed the JSON
 * with a natural-language sentence containing commas (e.g. "Based on the diff,
 * here is my answer:"), the parser ran jsonrepair on the WHOLE string first,
 * which turned the comma-separated prose into a bogus array of strings and
 * swallowed the real JSON object as the last element. Downstream code then saw
 * an array with no expected fields. The parser must isolate the embedded JSON
 * object (fenced or braced) before any whole-text repair.
 */

import { describe, it, expect } from 'vitest';
import { EnhancedJSONParser } from '../../src/utils/json-parser.js';

describe('EnhancedJSONParser — prose-wrapped JSON', () => {
    it('clean JSON object still parses (fast path)', () => {
        const r: any = EnhancedJSONParser.parse('{"reasoning":"x","confidence":1}');
        expect(Array.isArray(r)).toBe(false);
        expect(r.reasoning).toBe('x');
    });

    it('prose preamble + fenced JSON returns the object, not an array', () => {
        const text = [
            'Based on the diff, the PR adds a cron, so here is my answer:',
            '```json',
            '{"reasoning":"adds a cron","action":{"type":"final_answer","content":"ok"}}',
            '```',
        ].join('\n');

        const r: any = EnhancedJSONParser.parse(text);

        expect(Array.isArray(r)).toBe(false);
        expect(r).toBeTypeOf('object');
        expect(r.reasoning).toBe('adds a cron');
        expect(r.action?.type).toBe('final_answer');
    });

    it('prose preamble + bare (unfenced) JSON returns the object', () => {
        const text =
            'Sure, here is the result, formatted as requested: {"reasoning":"y","confidence":0.9}';

        const r: any = EnhancedJSONParser.parse(text);

        expect(Array.isArray(r)).toBe(false);
        expect(r.reasoning).toBe('y');
    });

    it('does not mangle comma-laden prose into a string array', () => {
        const text =
            'First, I looked at this, then that, and finally concluded. {"ok":true}';

        const r: any = EnhancedJSONParser.parse(text);

        expect(Array.isArray(r)).toBe(false);
        expect(r.ok).toBe(true);
    });
});

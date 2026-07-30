/**
 * @file json-parser-sonnet-fixtures.test.ts
 * @description End-to-end proof against REAL Claude Sonnet 4.5 output.
 *
 * The fixtures in __fixtures__/sonnet-prose-responses.json are verbatim
 * responses captured from claude-sonnet-4-5 (extended thinking enabled, thinking
 * blocks stripped exactly as CustomStringOutputParser does), each prefixed with
 * a natural-language preamble ("Sim, esse cron roda diariamente, ...") — the
 * exact shape that crashed the @kody conversation in production.
 *
 * These run the REAL (fixed) EnhancedJSONParser and the REAL ReActStrategy
 * parseLLMResponse — no port, no synthetic strings — and assert they no longer
 * mangle into an array / throw "Missing or invalid reasoning field".
 */

import { describe, it, expect } from 'vitest';
import { EnhancedJSONParser } from '../../src/utils/json-parser.js';
import { ReActStrategy } from '../../src/engine/strategies/react-strategy.js';
import type { LLMAdapter } from '../../src/core/types/allTypes.js';
import { SONNET_PROSE_RESPONSES as fixtures } from './sonnet-prose-responses.fixture.js';

const strategy = new ReActStrategy({} as unknown as LLMAdapter);

describe('REAL Sonnet prose-preamble responses', () => {
    it('has fixtures that all start with a prose preamble (not raw JSON)', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(1);
        for (const f of fixtures) {
            expect(f.trimStart().startsWith('{')).toBe(false);
        }
    });

    it.each(fixtures.map((f, i) => [i, f] as const))(
        'fixture #%i: parser returns a JSON object (not a mangled array)',
        (_i, raw) => {
            const parsed: any = EnhancedJSONParser.parse(raw);
            expect(Array.isArray(parsed)).toBe(false);
            expect(parsed).toBeTypeOf('object');
            expect(typeof parsed.reasoning).toBe('string');
        },
    );

    it.each(fixtures.map((f, i) => [i, f] as const))(
        'fixture #%i: parseLLMResponse yields a usable thought (no throw)',
        (_i, raw) => {
            const thought = (strategy as any).parseLLMResponse(raw, 0);
            expect(thought.action).toBeDefined();
            expect(thought.action.type).toBe('final_answer');
            expect(thought.action.content.length).toBeGreaterThan(0);
        },
    );
});

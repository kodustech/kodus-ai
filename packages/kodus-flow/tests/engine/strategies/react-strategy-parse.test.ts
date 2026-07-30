/**
 * @file react-strategy-parse.test.ts
 * @description Regression tests for ReActStrategy.parseLLMResponse.
 *
 * Real-world bug (self-hosted, Claude Sonnet via BYOK): an `@kody` mention on a
 * PR failed with "I encountered an error while processing your request. Please
 * try rephrasing your question." The underlying cause was that the LLM returned
 * a VALID JSON object carrying a usable `action`, but WITHOUT a top-level string
 * `reasoning` field. `parseLLMResponse` hard-requires `reasoning` and throws
 * "Missing or invalid reasoning field in LLM response", which bubbles up to the
 * generic thought-generation fallback and kills the whole conversation on
 * iteration 0.
 *
 * `reasoning` is purely diagnostic — the `action` is what actually drives the
 * answer. When the model gives us a usable action but no reasoning, the agent
 * should still proceed instead of erroring out. These tests assert that desired
 * behavior, so they go RED against the current (broken) parser.
 */

import { describe, it, expect } from 'vitest';
import { ReActStrategy } from '../../../src/engine/strategies/react-strategy.js';
import type { LLMAdapter } from '../../../src/core/types/allTypes.js';

// parseLLMResponse never touches the adapter, so a stub is enough to construct.
const fakeAdapter = {} as unknown as LLMAdapter;

function parse(content: string) {
    const strategy = new ReActStrategy(fakeAdapter);
    // parseLLMResponse is private; exercise it directly.
    return (strategy as any).parseLLMResponse(content, 0);
}

describe('ReActStrategy.parseLLMResponse — missing reasoning field', () => {
    it('control: parses a well-formed envelope with reasoning + action', () => {
        const content = JSON.stringify({
            reasoning: 'The user asked what the PR changes; I can answer directly.',
            confidence: 0.9,
            action: {
                type: 'final_answer',
                content: 'This PR adds a license-inactivity cron.',
            },
        });

        const thought = parse(content);

        expect(thought.action.type).toBe('final_answer');
        expect(thought.action.content).toContain('license-inactivity');
    });

    it('answers when the model returns a valid action but omits reasoning (the Sonnet bug)', () => {
        // Claude/Sonnet sometimes drops the diagnostic `reasoning` key while
        // still returning a perfectly usable final_answer action.
        const content = JSON.stringify({
            action: {
                type: 'final_answer',
                content: 'This PR adds a license-inactivity cron.',
            },
        });

        const thought = parse(content);

        // Desired: degrade gracefully and still surface the answer, instead of
        // throwing "Missing or invalid reasoning field in LLM response".
        expect(thought.action.type).toBe('final_answer');
        expect(thought.action.content).toContain('license-inactivity');
    });

    it('answers when reasoning is written as prose OUTSIDE the JSON (Claude habit)', () => {
        // Claude commonly narrates its reasoning in prose, then emits a JSON
        // block that contains only the action. The brace extractor grabs the
        // inner object, which has no `reasoning` key.
        const content = [
            "Looking at the diff, the user just wants a one-line summary, so I'll answer directly.",
            '',
            '```json',
            JSON.stringify({
                action: {
                    type: 'final_answer',
                    content: 'It introduces a scheduled job to deactivate idle licenses.',
                },
            }),
            '```',
        ].join('\n');

        const thought = parse(content);

        expect(thought.action.type).toBe('final_answer');
        expect(thought.action.content).toContain('deactivate idle licenses');
    });

    it('answers when a prose preamble precedes a COMPLETE envelope (the real prod trigger)', () => {
        // SMOKING GUN: the model writes a natural-language sentence (with commas)
        // before the JSON. Running jsonrepair on the whole string turned that prose
        // into a bogus array `["Based on the diff", "here is my answer", ...]`, which
        // is a non-null object with no `reasoning`/`action` — producing exactly the
        // production "Missing or invalid reasoning field" crash even though the model
        // DID return a valid, reasoning-bearing envelope.
        const content = [
            'Based on the diff, the PR adds a cron, so here is my structured answer:',
            '',
            '```json',
            JSON.stringify({
                reasoning: 'The PR adds a daily cron to deactivate inactive licenses.',
                confidence: 0.95,
                hypotheses: [
                    {
                        approach: 'Answer from PR context',
                        confidence: 0.95,
                        action: {
                            type: 'final_answer',
                            content: 'It adds a daily cron that deactivates inactive licenses.',
                        },
                    },
                ],
            }),
            '```',
        ].join('\n');

        const thought = parse(content);

        expect(thought.action.type).toBe('final_answer');
        expect(thought.action.content).toContain('deactivates inactive licenses');
        // the real reasoning survived (not lost to array-mangling)
        expect(thought.reasoning).toContain('daily cron');
    });

    it('answers when reasoning is present but not a string (null/object)', () => {
        // Defensive: a non-string reasoning value must not be fatal either.
        const content = JSON.stringify({
            reasoning: null,
            action: {
                type: 'final_answer',
                content: 'Summary of the change.',
            },
        });

        const thought = parse(content);

        expect(thought.action.type).toBe('final_answer');
        expect(thought.action.content).toContain('Summary');
    });
});

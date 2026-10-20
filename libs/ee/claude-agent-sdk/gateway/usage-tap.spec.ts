import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EventStreamCodec } from '@smithy/eventstream-codec';
import { fromUtf8, toUtf8 } from '@smithy/util-utf8';

import { UsageTap, tapKindFor } from './usage-tap';

// A Messages stream as the API documents it: ping, thinking, text and a tool
// call, cache tokens in message_start, cumulative usage in message_delta.
const EVENTS = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 12, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300, output_tokens: 1 } } },
    { type: 'ping' },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'looking' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the file.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__kodus__readFile', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 87 } },
    { type: 'message_stop' },
];

const SSE = Buffer.from(EVENTS.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''), 'utf8');

const EXPECTED = {
    usage: { inputTokens: 4312, outputTokens: 87, cacheReadTokens: 4000, cacheWriteTokens: 300 },
    output: 'Reading the file.\nmcp__kodus__readFile({"path":"a.ts"})',
    stopReason: 'tool_use',
};

// Feeds the body through the tap in pieces cut at arbitrary bytes, the way a
// socket delivers it, and keeps what comes out.
async function tapped(kind: 'sse' | 'eventstream' | 'json', body: Buffer, cut = 7) {
    const tap = new UsageTap(kind);
    const out: Buffer[] = [];
    const pieces: Buffer[] = [];
    for (let i = 0; i < body.length; i += cut) pieces.push(body.subarray(i, i + cut));
    await pipeline(
        Readable.from(pieces),
        tap,
        new Writable({
            write(chunk, _enc, done) {
                out.push(chunk);
                done();
            },
        }),
    );
    return { out: Buffer.concat(out), result: tap.result() };
}

describe('usage tap', () => {
    it('passes an SSE body through byte for byte and reads usage (cache included in input) and output', async () => {
        for (const cut of [1, 7, 64, SSE.length]) {
            const { out, result } = await tapped('sse', SSE, cut);
            expect(out.equals(SSE)).toBe(true);
            expect(result).toEqual(EXPECTED);
        }
    });

    it('reads the same events out of a Bedrock event stream encoded by AWS’s codec, bytes unchanged', async () => {
        const codec = new EventStreamCodec(toUtf8, fromUtf8);
        const frames = EVENTS.map((e) =>
            Buffer.from(
                codec.encode({
                    headers: {
                        ':event-type': { type: 'string', value: 'chunk' },
                        ':content-type': { type: 'string', value: 'application/json' },
                        ':message-type': { type: 'string', value: 'event' },
                    },
                    body: fromUtf8(JSON.stringify({ bytes: Buffer.from(JSON.stringify(e)).toString('base64') })),
                }),
            ),
        );
        const body = Buffer.concat(frames);
        for (const cut of [1, 13, body.length]) {
            const { out, result } = await tapped('eventstream', body, cut);
            expect(out.equals(body)).toBe(true);
            expect(result).toEqual(EXPECTED);
        }
    });

    it('reads a non-streaming Message', async () => {
        const message = {
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            content: [
                { type: 'text', text: 'done' },
                { type: 'tool_use', id: 't', name: 'StructuredOutput', input: { severity: 'high' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 20 },
        };
        const body = Buffer.from(JSON.stringify(message));
        const { out, result } = await tapped('json', body);
        expect(out.equals(body)).toBe(true);
        expect(result).toEqual({
            usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 20 },
            output: 'done\nStructuredOutput({"severity":"high"})',
            stopReason: 'tool_use',
        });
    });

    it('takes input from message_delta when the API reports it there, and the last delta wins', async () => {
        const events = [
            { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
            { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 10 } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 9, output_tokens: 20 } },
        ];
        const body = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
        const { result } = await tapped('sse', body);
        expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
        expect(result.stopReason).toBe('end_turn');
    });

    it('leaves usage unknown for a body it cannot read, and still passes it through', async () => {
        const body = Buffer.from('data: {not json\n\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n');
        const { out, result } = await tapped('sse', body);
        expect(out.equals(body)).toBe(true);
        expect(result.usage).toBeUndefined();
    });

    it('picks the body kind from the content type', () => {
        expect(tapKindFor('text/event-stream; charset=utf-8')).toBe('sse');
        expect(tapKindFor('application/vnd.amazon.eventstream')).toBe('eventstream');
        expect(tapKindFor('application/json')).toBe('json');
        expect(tapKindFor('text/html')).toBeNull();
        expect(tapKindFor(undefined)).toBeNull();
    });
});

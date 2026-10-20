/**
 * Reads usage and output from an upstream Messages response while the bytes
 * pass through untouched. Three bodies: Anthropic SSE (first-party and
 * Vertex), the AWS event stream Bedrock wraps the same events in, and the
 * plain JSON of a non-streaming call.
 *
 * Usage semantics follow the AI SDK's (`libs/llm/ai-sdk-usage.ts`): `inputTokens`
 * is the whole prompt, cached parts included, so the cost calculator can take
 * `cacheReadTokens` and `cacheWriteTokens` out of it as it does today.
 */
import { Transform, type TransformCallback } from 'node:stream';

import { emptyUsage, type LedgerUsage } from './ledger';

export type TapKind = 'sse' | 'eventstream' | 'json';

export interface TapResult {
    usage?: LedgerUsage;
    /** Assistant text, then each tool call as `name(input)`, for the trace. */
    output: string;
    stopReason?: string;
}

interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

/** Folds Messages stream events (or one Message) into usage and output. */
export class MessageAccumulator {
    private start: AnthropicUsage | undefined;
    private delta: AnthropicUsage | undefined;
    private text = '';
    private readonly tools = new Map<number, { name: string; json: string }>();
    private stopReason: string | undefined;

    event(e: any): void {
        switch (e?.type) {
            case 'message_start':
                this.start = e.message?.usage;
                break;
            case 'content_block_start':
                if (e.content_block?.type === 'tool_use') this.tools.set(e.index, { name: e.content_block.name, json: '' });
                break;
            case 'content_block_delta':
                if (e.delta?.type === 'text_delta') this.text += e.delta.text ?? '';
                else if (e.delta?.type === 'input_json_delta') {
                    const tool = this.tools.get(e.index);
                    if (tool) tool.json += e.delta.partial_json ?? '';
                }
                break;
            case 'message_delta':
                // Cumulative: the last one holds the final counts.
                this.delta = { ...this.delta, ...e.usage };
                if (e.delta?.stop_reason) this.stopReason = e.delta.stop_reason;
                break;
        }
    }

    message(m: any): void {
        this.start = m?.usage;
        this.stopReason = m?.stop_reason ?? undefined;
        (m?.content ?? []).forEach((block: any, index: number) => {
            if (block?.type === 'text') this.text += block.text ?? '';
            else if (block?.type === 'tool_use') this.tools.set(index, { name: block.name, json: JSON.stringify(block.input ?? {}) });
        });
    }

    result(): TapResult {
        const tools = [...this.tools.values()].map((t) => `${t.name}(${t.json})`);
        const output = [this.text, ...tools].filter(Boolean).join('\n');
        if (!this.start && !this.delta) return { output, stopReason: this.stopReason };
        const pick = (key: keyof AnthropicUsage) => this.delta?.[key] ?? this.start?.[key] ?? 0;
        const cacheRead = pick('cache_read_input_tokens');
        const cacheWrite = pick('cache_creation_input_tokens');
        return {
            output,
            stopReason: this.stopReason,
            usage: {
                ...emptyUsage(),
                inputTokens: pick('input_tokens') + cacheRead + cacheWrite,
                outputTokens: pick('output_tokens'),
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
            },
        };
    }
}

/** Splits an SSE byte stream into `data:` payloads. */
class SseParser {
    private buffer = '';
    constructor(private readonly onData: (data: string) => void) {}

    push(chunk: Buffer): void {
        this.buffer += chunk.toString('utf8');
        let cut: number;
        while ((cut = this.buffer.search(/\r?\n\r?\n/)) >= 0) {
            const raw = this.buffer.slice(0, cut);
            this.buffer = this.buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
            const data = raw
                .split(/\r?\n/)
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).replace(/^ /, ''))
                .join('\n');
            if (data) this.onData(data);
        }
    }
}

/**
 * Splits an AWS event stream into its payloads: each frame is a 4-byte total
 * length, a 4-byte headers length, a prelude CRC, headers, the payload and a
 * message CRC. Bedrock's `chunk` payload is `{"bytes": base64(event JSON)}`.
 */
class EventStreamParser {
    private buffer = Buffer.alloc(0);
    constructor(private readonly onPayload: (payload: Buffer) => void) {}

    push(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 12) {
            const total = this.buffer.readUInt32BE(0);
            if (total < 16 || this.buffer.length < total) break;
            const headersLength = this.buffer.readUInt32BE(4);
            const payload = this.buffer.subarray(12 + headersLength, total - 4);
            this.onPayload(Buffer.from(payload));
            this.buffer = this.buffer.subarray(total);
        }
    }
}

/**
 * A pass-through stream: what goes in comes out byte for byte, as it arrives.
 * `result()` is final once the stream has ended. A body it cannot read leaves
 * usage undefined; it never breaks the pass-through.
 */
export class UsageTap extends Transform {
    private readonly acc = new MessageAccumulator();
    private readonly json: Buffer[] = [];
    private readonly sse?: SseParser;
    private readonly events?: EventStreamParser;
    private broken = false;

    constructor(private readonly kind: TapKind) {
        super();
        if (kind === 'sse') this.sse = new SseParser((data) => this.safely(() => this.acc.event(JSON.parse(data))));
        if (kind === 'eventstream') {
            this.events = new EventStreamParser((payload) =>
                this.safely(() => {
                    const bytes = JSON.parse(payload.toString('utf8')).bytes;
                    if (bytes) this.acc.event(JSON.parse(Buffer.from(bytes, 'base64').toString('utf8')));
                }),
            );
        }
    }

    private safely(fn: () => void): void {
        if (this.broken) return;
        try {
            fn();
        } catch {
            this.broken = true;
        }
    }

    _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
        this.safely(() => {
            if (this.kind === 'json') this.json.push(chunk);
            else if (this.sse) this.sse.push(chunk);
            else this.events?.push(chunk);
        });
        done(null, chunk);
    }

    _flush(done: TransformCallback): void {
        if (this.kind === 'json') this.safely(() => this.acc.message(JSON.parse(Buffer.concat(this.json).toString('utf8'))));
        done();
    }

    result(): TapResult {
        return this.broken ? { output: '' } : this.acc.result();
    }
}

/** Which body a response carries, from its content type. */
export function tapKindFor(contentType: string | undefined): TapKind | null {
    const ct = (contentType ?? '').toLowerCase();
    if (ct.includes('text/event-stream')) return 'sse';
    if (ct.includes('application/vnd.amazon.eventstream')) return 'eventstream';
    if (ct.includes('application/json')) return 'json';
    return null;
}

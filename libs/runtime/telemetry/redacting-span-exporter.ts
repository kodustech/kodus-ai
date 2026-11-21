import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter, TimedEvent } from '@opentelemetry/sdk-trace-base';

import { scrubText, spanAttributes } from './telemetry-guard';

// The last gate before a span leaves a Runtime process: whatever a caller
// set, only taxonomy attributes with checked values are exported, events keep
// only their name and their checked attributes, and the status message (an
// exception's text can carry anything) is dropped. otel.ts wraps every
// exporter it configures in this one.

function guarded(span: ReadableSpan): ReadableSpan {
    const events: TimedEvent[] = span.events.map((e) => ({ ...e, attributes: spanAttributes(e.attributes) }));
    return Object.create(span, {
        name: { value: scrubText(span.name).text, enumerable: true },
        attributes: { value: spanAttributes(span.attributes), enumerable: true },
        events: { value: events, enumerable: true },
        status: { value: { code: span.status.code }, enumerable: true },
        links: { value: span.links.map((l) => ({ ...l, attributes: spanAttributes(l.attributes) })), enumerable: true },
    }) as ReadableSpan;
}

export class RedactingSpanExporter implements SpanExporter {
    constructor(private readonly next: SpanExporter) {}

    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
        this.next.export(spans.map(guarded), resultCallback);
    }

    shutdown(): Promise<void> {
        return this.next.shutdown();
    }

    forceFlush(): Promise<void> {
        return this.next.forceFlush?.() ?? Promise.resolve();
    }
}

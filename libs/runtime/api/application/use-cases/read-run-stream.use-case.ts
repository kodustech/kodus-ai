import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { InvalidStreamOffsetError, type RunStreamEvent, type RunStreamPage } from '@libs/runtime/run';

import {
    RUNTIME_API_CONFIG,
    RUNTIME_RUN_STREAM_STORE,
    type RunStreamStore,
    type RuntimeApiConfig,
} from '../../domain/ports';
import { RuntimeRunAccessService, type RuntimePrincipal } from '../run-access.service';
import { publicRunEvent } from '../run-public-view';

export interface RunStreamResponse {
    /** 200 with events, or 204 when a long-poll timed out with nothing new. */
    status: 200 | 204;
    events: RunStreamEvent[];
    nextOffset: string;
    upToDate: boolean;
}

const START = '-1';

const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });

/**
 * GET /runtime/runs/:id/stream — the Run stream in the Durable Streams style
 * (ADR-047): catch-up read from an opaque offset, or long-poll for what comes
 * next. The hub only writes the stream; the API serves it after the object check.
 */
@Injectable()
export class ReadRuntimeRunStreamUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_RUN_STREAM_STORE)
        private readonly streams: RunStreamStore,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
    ) {}

    async execute(input: {
        principal: RuntimePrincipal;
        runId: string;
        offset?: string;
        live?: string;
        signal?: AbortSignal;
    }): Promise<RunStreamResponse> {
        if (input.live !== undefined && input.live !== 'long-poll') {
            throw new BadRequestException('live must be "long-poll"');
        }
        if (input.offset !== undefined && (typeof input.offset !== 'string' || input.offset.length > 64)) {
            throw new BadRequestException('invalid offset');
        }
        const run = await this.access.load(input.principal, input.runId);
        const read = () => this.read(run.organizationId, run.runId, input.offset);

        let page = await read();
        if (input.live === 'long-poll' && page.events.length === 0) {
            const deadline = Date.now() + this.config.streamLongPollMs;
            while (!input.signal?.aborted && Date.now() < deadline) {
                await sleep(Math.min(this.config.streamPollIntervalMs, Math.max(0, deadline - Date.now())), input.signal);
                page = await read();
                if (page.events.length > 0) break;
            }
            if (page.events.length === 0) return { status: 204, ...page };
        }
        return { status: 200, ...page };
    }

    private async read(organizationId: string, runId: string, offset?: string): Promise<RunStreamPage> {
        try {
            const page = await this.streams.read(organizationId, runId, offset);
            // The hub has not written anything yet (or retention dropped it):
            // an empty, up-to-date stream that resumes from the start.
            return page ? { ...page, events: page.events.map(publicRunEvent) } : { events: [], nextOffset: START, upToDate: true };
        } catch (e) {
            if (e instanceof InvalidStreamOffsetError) throw new BadRequestException('invalid offset');
            throw e;
        }
    }
}

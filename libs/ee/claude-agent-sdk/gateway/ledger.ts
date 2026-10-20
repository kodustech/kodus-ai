/**
 * What one SDK session sent upstream: every request's status, usage and time,
 * the compactions the CLI ran, and each upstream error as the provider sent it.
 * The executor sums the usage into the call's one span and builds the
 * attempt's error from the last upstream error.
 */
export interface LedgerUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

export type CompactionKind = 'auto' | 'manual' | 'reactive';

export interface LedgerRequest {
    status: number;
    ms: number;
    usage?: LedgerUsage;
    compaction?: CompactionKind;
}

export interface UpstreamError {
    status: number;
    body: string;
    retryAfter?: string;
}

export interface SessionLedgerSnapshot {
    requests: LedgerRequest[];
    upstreamErrors: UpstreamError[];
    usage: LedgerUsage;
    compactions: number;
}

const COMPACTION_KINDS: ReadonlySet<string> = new Set(['auto', 'manual', 'reactive']);

/** The CLI marks a compaction request with `x-claude-code-compaction: <kind>`. */
export function compactionOf(header: string | string[] | undefined): CompactionKind | undefined {
    const value = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
    return value && COMPACTION_KINDS.has(value) ? (value as CompactionKind) : undefined;
}

export function emptyUsage(): LedgerUsage {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export class SessionLedger {
    private readonly requests: LedgerRequest[] = [];
    private readonly errors: UpstreamError[] = [];

    record(request: LedgerRequest): void {
        this.requests.push(request);
    }

    recordError(error: UpstreamError): void {
        this.errors.push(error);
    }

    lastError(): UpstreamError | undefined {
        return this.errors[this.errors.length - 1];
    }

    snapshot(): SessionLedgerSnapshot {
        const usage = emptyUsage();
        for (const r of this.requests) {
            if (!r.usage) continue;
            usage.inputTokens += r.usage.inputTokens;
            usage.outputTokens += r.usage.outputTokens;
            usage.cacheReadTokens += r.usage.cacheReadTokens;
            usage.cacheWriteTokens += r.usage.cacheWriteTokens;
        }
        return {
            requests: this.requests.map((r) => ({ ...r })),
            upstreamErrors: this.errors.map((e) => ({ ...e })),
            usage,
            compactions: this.requests.filter((r) => r.compaction).length,
        };
    }
}

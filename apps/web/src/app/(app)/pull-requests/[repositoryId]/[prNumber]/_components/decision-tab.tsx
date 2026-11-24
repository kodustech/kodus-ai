"use client";

import { useEffect, useState } from "react";

import { authorizedFetch } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

/**
 * DecisionTab — renders the per-PR reconciler's source-of-truth row on
 * the PR page. Per `tasks.md §6.1`, the panel reads from
 * `pull-requests/<repoId>/<prNumber>/decision?headSha=...`.
 *
 * The read goes through `authorizedFetch`/`pathToApiUrl` like every other
 * client call: on the client the URL routes through the same-origin
 * `/api/proxy` route (which injects the Bearer token server-side), and the
 * helper unwraps the API's `{ data: … }` envelope.
 *
 * The row is the duck type returned by the controller; we don't bind to
 * the server-side TypeORM shape because the page only needs the
 * audit-trail projection.
 */

export interface PrDecisionRecord {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    configurationKey: string;
    gateVerdictsSnapshot: {
        snapshotKey: string;
        capturedAt: string;
        l0?: unknown;
        l1?: unknown;
        l2?: unknown;
        l3?: unknown;
        ac?: unknown;
    };
    lastApplyOutcome: {
        kind: "applied" | "partial" | "skipped-nochange";
        steps: ReadonlyArray<{
            step: "dismiss" | "approve" | "upsertComment";
            result: { status: "ok" | "retry" | "fatal"; reason?: string };
        }>;
        decidedAt: string;
    };
    lastReconciledAt: string;
    consecutiveFailures: number;
    inFlightTriggerKind: string | null;
}

/** Snapshot key short id (8 chars) for tight UI presentation. */
function shortSnapshot(s: string): string {
    return s.length > 8 ? `…${s.slice(-8)}` : s;
}

/** Renders one gate row (L0 / L1 / L2 / L3). */
function GateRow({
    label,
    verdict,
}: {
    label: string;
    verdict: unknown;
}) {
    if (verdict === undefined) {
        return (
            <div className="text-text-tertiary flex items-baseline justify-between border-b py-2 text-xs">
                <span className="font-medium tracking-wide uppercase">{label}</span>
                <span className="text-text-tertiary/70">—</span>
            </div>
        );
    }
    const v = verdict as
        | { status: "Ready"; value: unknown; snapshotKey: string }
        | { status: "Unavailable"; reason: string; snapshotKey: string }
        | { status: "Stale"; snapshotKey: string; priorSnapshotKey: string };
    if (v.status === "Ready") {
        const inner =
            typeof v.value === "object" && v.value !== null
                ? JSON.stringify(v.value)
                : String(v.value);
        return (
            <div className="border-card-lv2 flex items-baseline justify-between border-b py-2 text-xs">
                <span className="text-text-primary font-medium tracking-wide uppercase">
                    {label} ready
                </span>
                <span
                    className="text-text-tertiary max-w-md truncate font-mono"
                    title={inner}
                >
                    {inner || shortSnapshot(v.snapshotKey)}
                </span>
            </div>
        );
    }
    if (v.status === "Unavailable") {
        return (
            <div
                className="border-card-lv2 flex items-baseline justify-between border-b py-2 text-xs"
                data-testid={`gate-${label}-unavailable`}
            >
                <span className="text-amber-600 font-medium tracking-wide uppercase">
                    {label} unavailable
                </span>
                <span
                    className="text-text-tertiary max-w-md truncate font-mono"
                    title={v.reason}
                >
                    {v.reason}
                </span>
            </div>
        );
    }
    return (
        <div
            className="border-card-lv2 flex items-baseline justify-between border-b py-2 text-xs"
            data-testid={`gate-${label}-stale`}
        >
            <span className="text-amber-600 font-medium tracking-wide uppercase">
                {label} stale
            </span>
            <span className="text-text-tertiary font-mono">
                prior: {shortSnapshot(v.priorSnapshotKey)}
            </span>
        </div>
    );
}

export interface DecisionTabProps {
    repositoryId: string;
    prNumber: number;
    headSha: string;
    /** Polling interval. Default 5s. */
    pollMs?: number;
}

export function DecisionTab({
    repositoryId,
    prNumber,
    headSha,
    pollMs = 5_000,
}: DecisionTabProps) {
    const [record, setRecord] = useState<PrDecisionRecord | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const fetchOnce = async () => {
            try {
                const url = pathToApiUrl(
                    `/pull-requests/${encodeURIComponent(
                        repositoryId,
                    )}/${prNumber}/decision`,
                );
                const body = await authorizedFetch<PrDecisionRecord>(url, {
                    params: { headSha },
                });
                if (cancelled) return;
                if (!body) {
                    // authorizedFetch returns null on 401 (session gone).
                    setError("HTTP 401");
                    setRecord(null);
                    return;
                }
                setRecord(body);
                setError(null);
            } catch (err) {
                if (cancelled) return;
                const status = (err as { statusCode?: number })?.statusCode;
                setError(
                    status
                        ? `HTTP ${status}`
                        : err instanceof Error
                          ? err.message
                          : String(err),
                );
                setRecord(null);
            }
        };
        void fetchOnce();
        const handle = setInterval(fetchOnce, pollMs);
        return () => {
            cancelled = true;
            clearInterval(handle);
        };
    }, [repositoryId, prNumber, headSha, pollMs]);

    if (error) {
        return (
            <div
                className="text-text-tertiary/70 p-4 text-xs"
                data-testid="decision-error"
            >
                Decision state unavailable: {error}
            </div>
        );
    }
    if (!record) {
        return (
            <div
                className="text-text-tertiary/70 p-4 text-xs"
                data-testid="decision-loading"
            >
                Loading decision state…
            </div>
        );
    }
    return (
        <div className="flex h-full flex-col text-xs" data-testid="decision-panel">
            <div className="border-card-lv2 border-b px-4 py-3">
                <h3 className="text-text-tertiary font-semibold tracking-wider uppercase">
                    Kody decision
                </h3>
            </div>

            <div className="border-card-lv2 border-b px-4 py-3">
                <div className="flex items-baseline gap-2">
                    <span className="text-text-primary text-sm font-semibold">
                        {record.lastApplyOutcome.kind === "applied"
                            ? "applied"
                            : record.lastApplyOutcome.kind}
                    </span>
                    <span className="text-text-tertiary/70">
                        cfg {shortSnapshot(record.configurationKey)}
                    </span>
                </div>
                <p className="text-text-tertiary mt-1 text-xs">
                    Reconciled at {shortSnapshot(record.lastApplyOutcome.decidedAt)}
                </p>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3">
                <GateRow label="L0" verdict={record.gateVerdictsSnapshot.l0} />
                <GateRow label="L1" verdict={record.gateVerdictsSnapshot.l1} />
                <GateRow label="L2" verdict={record.gateVerdictsSnapshot.l2} />
                <GateRow label="L3" verdict={record.gateVerdictsSnapshot.l3} />
            </div>

            {record.consecutiveFailures > 0 && (
                <div
                    className="border-card-lv2 border-t bg-[var(--bg-2)]/60 px-4 py-2 text-xs"
                    data-testid="decision-retry-banner"
                >
                    <span className="text-text-tertiary">
                        consecutive failures:{" "}
                        {record.consecutiveFailures}
                    </span>
                </div>
            )}
        </div>
    );
}

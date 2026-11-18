import { cn } from "src/core/utils/components";

/** One heavy-mode lens on the "Specialist Agents" timeline entry, per batch. */
interface SpecialistEntry {
    label: string;
    status: "running" | "success" | "failed" | "no-result" | "stopped";
    batchIndex?: number;
    found?: number;
    kept?: number;
    durationMs?: number;
    toolCalls?: number;
    error?: string;
}

interface SpecialistRow {
    label: string;
    name: string;
    status: SpecialistEntry["status"];
    kept?: number;
    durationMs?: number;
    toolCalls?: number;
    error?: string;
}

const NAMES: Record<string, string> = {
    "lens-says-one-thing-does-another": "Says one thing, does another",
    "lens-text-that-ships": "Text that ships",
    "lens-invalid-state-and-concurrency": "Invalid state and concurrency",
    "lens-value-boundary-and-position": "Value, boundary and position",
    "lens-secret-and-identity": "Secret and identity",
    "lens-contract-not-followed": "Contract not followed",
    "lens-test-does-not-verify": "Test does not verify",
    "lens-data-exposure": "Data exposure",
    "lens-changed-files-disagree": "Changed files disagree",
};

const nameOf = (label: string) => {
    if (NAMES[label]) return NAMES[label];
    const words = label.replace(/^lens-/, "").replace(/-/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
};

const STATUS_RANK: Record<SpecialistEntry["status"], number> = {
    "running": 3,
    "failed": 2,
    "no-result": 1,
    "success": 0,
    // Stopped with its batch's generalist: shown only when no batch ran it.
    "stopped": -1,
};

const sum = (values: Array<number | undefined>) =>
    values.some((v) => v !== undefined)
        ? values.reduce<number>((total, v) => total + (v ?? 0), 0)
        : undefined;

/** The lenses of the entry, one row per lens: a chunked review ran each once
 *  per batch, and the row adds the batches up. */
export const getSpecialists = (metadata?: unknown): SpecialistRow[] | null => {
    if (!metadata || typeof metadata !== "object") return null;
    const raw = (metadata as Record<string, unknown>).specialists;
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const byLens = new Map<string, SpecialistEntry[]>();
    for (const entry of raw as SpecialistEntry[]) {
        if (!entry?.label || !Object.hasOwn(STATUS_RANK, entry.status))
            continue;
        byLens.set(entry.label, [...(byLens.get(entry.label) ?? []), entry]);
    }

    return [...byLens.entries()].map(([label, entries]) => {
        const counted = entries.filter((e) => e.status !== "stopped");
        const status = entries.reduce<SpecialistEntry["status"]>(
            (worst, e) =>
                STATUS_RANK[e.status] > STATUS_RANK[worst] ? e.status : worst,
            entries[0].status,
        );
        return {
            label,
            name: nameOf(label),
            status,
            kept:
                status === "running"
                    ? undefined
                    : sum(counted.map((e) => e.kept)),
            durationMs: sum(entries.map((e) => e.durationMs)),
            toolCalls: sum(entries.map((e) => e.toolCalls)),
            error: entries.find((e) => e.error)?.error,
        };
    });
};

const formatMs = (ms?: number) => {
    if (ms === undefined) return "—";
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, "0")}s`;
};

const DOT: Record<SpecialistEntry["status"], string> = {
    "success": "bg-success",
    "failed": "bg-danger",
    "no-result": "bg-danger",
    "running": "bg-info",
    "stopped": "bg-text-tertiary",
};

export const SpecialistAgentsTable = ({ rows }: { rows: SpecialistRow[] }) => {
    const failed = rows.filter(
        (r) => r.status === "failed" || r.status === "no-result",
    ).length;
    return (
        <details className="text-text-tertiary mt-2 text-xs" open>
            <summary className="cursor-pointer">
                {rows.length} agents{failed > 0 ? ` (${failed} failed)` : ""}
            </summary>
            <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[26rem] tabular-nums">
                    <thead>
                        <tr className="text-left">
                            <th className="py-1 pr-3 font-medium">Agent</th>
                            <th className="py-1 pr-3 text-right font-medium">
                                Duration
                            </th>
                            <th className="py-1 pr-3 text-right font-medium">
                                Tool calls
                            </th>
                            <th
                                className="py-1 text-right font-medium"
                                title="Kept after verify, before dedup">
                                Findings
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr
                                key={r.label}
                                className="border-card-lv3/50 border-t align-top">
                                <td className="text-text-secondary py-1.5 pr-3">
                                    <span className="flex items-center gap-2">
                                        <span
                                            className={cn(
                                                "size-1.5 shrink-0 rounded-full",
                                                DOT[r.status],
                                            )}
                                        />
                                        {r.name}
                                    </span>
                                    {r.status === "stopped" && !r.error && (
                                        <span className="block pl-3.5">
                                            Stopped
                                        </span>
                                    )}
                                    {r.error && (
                                        <span className="text-danger block pl-3.5">
                                            {r.error}
                                        </span>
                                    )}
                                </td>
                                <td className="py-1.5 pr-3 text-right">
                                    {formatMs(r.durationMs)}
                                </td>
                                <td className="py-1.5 pr-3 text-right">
                                    {r.toolCalls ?? "—"}
                                </td>
                                <td className="py-1.5 text-right">
                                    {r.kept ?? "—"}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </details>
    );
};

import type { RunBootFailure, RuntimeRun } from "../contracts";
import { blockerKindLabel } from "../labels";

// Why a side did not boot, as a terminal panel: the cell's title, the error
// line and the last log lines it kept (redacted by the cell). The backend
// may serve it as `bootFailure` or `bootFailureDetail`; either is read.
// Shown where the boot is the story: a Run that could not boot, a PR that
// does not boot while main does (a boot regression), and a partly tested
// Run whose PR side never came up.

export type BootFailureLine = { key: string; text: string; error: boolean };

export type BootFailureView = {
    side: "base" | "pr";
    /** "main" or "this PR". */
    sideLabel: string;
    title: string;
    /** "Toolchain", from the blocker kind. */
    kindLabel: string;
    signature: string;
    at: string;
    errorLine?: string;
    lines: BootFailureLine[];
    /** The error line is one of `lines` (highlighted there); otherwise it is drawn on its own. */
    errorInTail: boolean;
    /** The cause is Kodus's own (isKodusSideBootFailure): nothing in the repository to change. */
    kodusSide: boolean;
};

/** The refusals a Run waits on (no free host, the org's cap): a timed out Run shows them as its card. */
const CAPACITY_SIGNATURES: ReadonlySet<string> = new Set(["no_capacity", "org_capacity"]);

/** A Run that timed out waiting for a host carries the last refusal as its boot card. */
export const timedOutForCapacity = (
    run: Pick<RuntimeRun, "state" | "bootFailure" | "bootFailureDetail">,
): boolean => {
    const f = bootFailureDetailOf(run);
    return run.state === "timed_out" && !!f && CAPACITY_SIGNATURES.has(String(f.signature ?? ""));
};

/** How many tail lines show before "Show the last N lines". */
export const BOOT_TAIL_PREVIEW = 6;

const isFailure = (v: unknown): v is RunBootFailure => {
    if (!v || typeof v !== "object") return false;
    const f = v as Partial<RunBootFailure>;
    return (
        (f.side === "base" || f.side === "pr") &&
        typeof f.title === "string" &&
        f.title.trim() !== ""
    );
};

/**
 * The boot failed on Kodus's side: the catalog's `platform` kind (Kodus's own
 * steps, such as `repo_fetch`, and hosts the sandbox does not reach, whose
 * fix is "run the setup again"). One `platform` signature is not: a service
 * that listens on 127.0.0.1 only (`platform:not_listening:…`), whose fix is
 * the developer's (libs/runtime/blockers/rules/setup.ts).
 */
export const isKodusSideBootFailure = (
    f: Pick<RunBootFailure, "kind" | "signature"> | undefined,
): boolean =>
    !!f &&
    f.kind === "platform" &&
    !String(f.signature ?? "").startsWith("platform:not_listening");

/** The detail under either name, when its shape holds. */
export const bootFailureDetailOf = (
    run: Pick<RuntimeRun, "bootFailure" | "bootFailureDetail">,
): RunBootFailure | undefined =>
    [run.bootFailure, run.bootFailureDetail].find(isFailure);

const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * The panel, when this Run's story is a boot: could_not_boot (either side),
 * or a regression or a partly tested Run whose PR side did not boot.
 */
export const bootFailureOf = (
    run: Pick<RuntimeRun, "state" | "bootFailure" | "bootFailureDetail">,
): BootFailureView | undefined => {
    const f = bootFailureDetailOf(run);
    if (!f) return undefined;
    const shown =
        run.state === "could_not_boot" ||
        // A Run that waited for a host past its budget: the last refusal is its card.
        (run.state === "timed_out" && CAPACITY_SIGNATURES.has(String(f.signature ?? ""))) ||
        ((run.state === "regression" || run.state === "partly_tested") &&
            f.side === "pr");
    if (!shown) return undefined;
    const errorLine = f.errorLine?.trim() || undefined;
    let marked = false;
    const lines = strings(f.logTail).map((text, i) => {
        // The cell's error line may carry less than the log line (no build prefix).
        const error = !marked && !!errorLine && text.includes(errorLine);
        if (error) marked = true;
        return { key: `${i}`, text, error };
    });
    return {
        side: f.side,
        sideLabel: f.side === "base" ? "main" : "this PR",
        title: f.title.trim(),
        kindLabel: f.kind ? blockerKindLabel(f.kind) : "",
        signature: typeof f.signature === "string" ? f.signature : "",
        at: typeof f.at === "string" ? f.at : "",
        ...(errorLine ? { errorLine } : {}),
        lines,
        errorInTail: marked,
        kodusSide: isKodusSideBootFailure(f) || timedOutForCapacity(run),
    };
};

/** The lines shown while the tail is collapsed: the last few, always with the error line. */
export const bootTailPreview = (
    view: Pick<BootFailureView, "lines">,
    size = BOOT_TAIL_PREVIEW,
): BootFailureLine[] => {
    const tail = view.lines.slice(-size);
    const error = view.lines.find((l) => l.error);
    return error && !tail.includes(error) ? [error, ...tail.slice(1)] : tail;
};

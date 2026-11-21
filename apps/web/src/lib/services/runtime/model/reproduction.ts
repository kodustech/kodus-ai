import type { ReproductionDownload } from "@libs/runtime/run/reproduction";

const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max;
const sha = (value: unknown) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

/** Inert JSON only; reject old scripts and mismatched cached responses before copy/download. */
export function readReproductionDownload(
    value: unknown,
    expected: { runId: string; probeId: string },
): ReproductionDownload | undefined {
    if (!record(value) || !only(value, ["filename", "manifest"]) ||
        typeof value.filename !== "string" ||
        !/^kody-repro-pr[1-9]\d*-[A-Za-z0-9_.-]{1,64}\.json$/.test(value.filename) ||
        !record(value.manifest)) return undefined;
    const manifest = value.manifest;
    if (!only(manifest, ["schemaVersion", "kind", "run", "probe"]) ||
        manifest.schemaVersion !== 1 || manifest.kind !== "kodus.runtime.reproduction" ||
        !record(manifest.run) || !record(manifest.probe)) return undefined;
    const run = manifest.run;
    const probe = manifest.probe;
    if (!only(run, ["runId", "repositoryName", "prNumber", "baseSha", "headSha", "imageId"]) ||
        run.runId !== expected.runId || !text(run.repositoryName, 512) ||
        !Number.isSafeInteger(run.prNumber) || Number(run.prNumber) < 1 ||
        !sha(run.baseSha) || !sha(run.headSha) ||
        (run.imageId !== undefined && (!text(run.imageId, 512) || run.imageId.trim() !== run.imageId || run.imageId === "latest"))) return undefined;
    if (!only(probe, ["probeId", "entryPoint", "purpose", "expected", "spec", "targetKind", "base", "pr"]) ||
        probe.probeId !== expected.probeId || !text(probe.entryPoint, 512) ||
        !text(probe.purpose, 512) || !text(probe.expected, 2048) || !record(probe.spec)) return undefined;
    const kind = probe.spec.kind;
    const fields = kind === "http"
        ? ["kind", "target", "method", "path", "headers", "body", "role", "timeoutMs"]
        : kind === "sql" ? ["kind", "target", "query", "timeoutMs"]
        : kind === "browser" ? ["kind", "steps", "viewport", "role", "clock", "timeoutMs"] : undefined;
    if (!fields || !only(probe.spec, fields)) return undefined;
    // The API owns full probe-schema validation. The UI only renders/copies JSON;
    // it never interprets a query, browser step or any other value as executable.
    if (JSON.stringify(value).length > 1_048_576) return undefined;
    return value as unknown as ReproductionDownload;
}

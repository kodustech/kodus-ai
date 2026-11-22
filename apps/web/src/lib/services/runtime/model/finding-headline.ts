import { baseVersionLabel } from "./base-version";
import type { Finding } from "./findings";
import { buildResponseDiff } from "./response-diff";

// The headline and the proof of a finding, built from the recorded data only
// (answers, status codes, responseDiff). The planner's intent sentence never
// reaches them.

const METHOD_PATH = /^([A-Z]+)\s+(?:[^\s/]*)(\/\S*)?$/;

/** "POST /orders": method and path, without the service and port a request line carries. */
export const methodAndPath = (f: Pick<Finding, "route" | "request">) => {
    for (const source of [f.route, f.request]) {
        const m = source ? METHOD_PATH.exec(source.trim()) : null;
        if (m && m[2]) return `${m[1]} ${m[2]}`;
    }
    return f.route;
};

const STATUS_TEXT: Record<number, string> = {
    200: "OK",
    201: "Created",
    202: "Accepted",
    204: "No Content",
    301: "Moved Permanently",
    302: "Found",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    409: "Conflict",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
};

export const statusLabel = (status: number) =>
    STATUS_TEXT[status] ? `${status} ${STATUS_TEXT[status]}` : `${status}`;

const firstStatus = (side: Finding["base"]) =>
    side.rounds.find((r) => r.status !== undefined)?.status;

const field = (path: string) => path.replace(/^(body|response)\./, "");

/** One plain sentence: what changed on this PR, from the data. */
export const findingHeadline = (f: Finding): string => {
    const route = methodAndPath(f);
    if (f.boot)
        return `This PR does not start, while ${f.baseLabel ?? baseVersionLabel()} does`;
    const base = firstStatus(f.base);
    const pr = firstStatus(f.pr);
    if (base !== undefined && pr !== undefined && base !== pr)
        return pr >= 500
            ? `${route} now fails with ${pr} instead of ${base}`
            : `${route} now returns ${pr} instead of ${base}`;
    const leaf = f.leafChanges?.undescribed[0];
    if (leaf) {
        const more = f.leafChanges!.undescribed.length - 1;
        const tail = more > 0 ? ` (and ${more} more)` : "";
        if (leaf.kind === "removed")
            return `${route} no longer returns ${leaf.path}${tail}`;
        if (leaf.kind === "added")
            return `${route} now also returns ${leaf.path}${tail}`;
        return `${route} returns a different ${leaf.path}${tail}`;
    }
    const row = buildResponseDiff(f.responseDiff)?.rows[0];
    if (row) {
        const name = field(row.path);
        if (row.change === "removed")
            return `${route} no longer returns ${name}`;
        if (row.change === "added") return `${route} now also returns ${name}`;
        return `${route} returns a different ${name}`;
    }
    const [first] = f.differingFields.filter((x) => x !== "status");
    if (first) return `${route} returns a different ${field(first)}`;
    return `${route} behaves differently on this PR`;
};

/** The key a read path ends in, without its array indexes: `applinks.details[0].appIDs` is `appIDs`. */
const lastKeyOf = (path: string) =>
    path.replace(/\[\d+\]/g, "").split(".").pop() || path;

const MAX_LEAVES_SENTENCE = 3;

type Leaf = NonNullable<Finding["leafChanges"]>["undescribed"][number];

const leafPhrase = (l: Leaf) =>
    l.kind === "added"
        ? `${l.path} was added as ${l.pr ?? ""}`
        : l.kind === "removed"
          ? `${l.path} was removed (it was ${l.base ?? ""})`
          : l.kind === "reordered"
            ? `${l.path} was reordered`
            : `${l.path} changed from ${l.base ?? ""} to ${l.pr ?? ""}`;

/**
 * What the finding is about, leaf by leaf: the leaves the PR's description
 * does not read and which paths it does read. Built from the recorded leaves
 * only, the same sentence the PR comment carries.
 */
export const leafSentence = (f: Pick<Finding, "leafChanges">): string | undefined => {
    const set = f.leafChanges;
    if (!set?.undescribed.length) return undefined;
    const shown = set.undescribed.slice(0, MAX_LEAVES_SENTENCE).map(leafPhrase).join("; ");
    const more = set.undescribed.length - MAX_LEAVES_SENTENCE;
    const names = [...new Set(set.mentions.map(lastKeyOf))].slice(0, 3);
    const mentions = names.length ? ` The description only mentions ${names.join(", ")}.` : "";
    const rest = set.described.length
        ? ` (${set.described.length} other ${set.described.length === 1 ? "change matches" : "changes match"} what the PR describes.)`
        : "";
    return `${shown}${more > 0 ? ` (+${more} more below)` : ""}.${mentions}${rest}`;
};

const ERROR_FIELD = /(^|\.)(error|message|detail|reason)$/i;

/** What the PR's answer says: its error message, else the key changed field. */
const clueOf = (f: Finding): string | undefined => {
    const rows = buildResponseDiff(f.responseDiff)?.rows ?? [];
    const row = rows.find((r) => ERROR_FIELD.test(r.path) && r.pr) ?? rows[0];
    if (!row) return undefined;
    if (ERROR_FIELD.test(row.path) && row.pr) return `"${row.pr}"`;
    if (row.change === "removed") return `no ${field(row.path)}`;
    return `${field(row.path)}: ${row.pr ?? ""}`;
};

export type FindingProof = {
    request: string;
    base: string;
    pr: string;
};

/** The request line and one line per side, for the monospace proof. */
export const findingProof = (f: Finding): FindingProof => {
    const side = (s: Finding["base"], clue?: string) => {
        const status = firstStatus(s);
        const answer = status !== undefined ? statusLabel(status) : s.answer;
        return clue ? `${answer} ${clue}` : answer;
    };
    const rows = buildResponseDiff(f.responseDiff)?.rows ?? [];
    const baseRow = rows.find((r) => ERROR_FIELD.test(r.path) && r.base);
    return {
        request: methodAndPath(f),
        base: side(f.base, baseRow ? `"${baseRow.base}"` : undefined),
        pr: side(f.pr, clueOf(f)),
    };
};

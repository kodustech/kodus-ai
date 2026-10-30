/**
 * Deterministic pre-LLM gate for the cross-repo pass (#1576).
 *
 * Spec: the pass only activates when the PR diff touches *boundary surface*
 * (string literals, enum members, exported symbols, payload/DTO fields, keys,
 * status values, or contract-ish paths). Internal-only refactors never trigger
 * it — so linked-repo clones and the boundary prompt stay off for pure
 * mechanical diffs.
 *
 * Cheap: single pass over added lines of the unified diff. No LLM, no network.
 */

import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

export type CrossRepoGateSignalKind =
    | 'string_literal'
    | 'export'
    | 'enum_or_type'
    | 'object_key'
    | 'status_or_state'
    | 'contract_path';

export type CrossRepoGateSignal = {
    kind: CrossRepoGateSignalKind;
    file: string;
    /** Short snippet of the triggering line (truncated). */
    sample?: string;
};

export type CrossRepoBoundaryGateResult = {
    /** When false, linked-repo tools + boundary prompt must stay off. */
    activate: boolean;
    reasons: string[];
    signals: CrossRepoGateSignal[];
};

/** Filenames that almost always encode a cross-service contract. */
const CONTRACT_PATH_RE =
    /(^|\/)(dto|dtos|schema|schemas|api|apis|contract|contracts|types?|interfaces?|models?|serializers?|clients?|adapters?|proto|openapi|swagger|graphql|endpoints?|payloads?|requests?|responses?)(\/|\.|$)/i;

/** Status/state/key-ish identifiers on the LHS of an assignment or property. */
const STATUS_STATE_RE =
    /\b(status|state|code|error|errorCode|error_code|type|kind|mode|phase|step|action|event|key|token|encoding|format|charset|locale|currency|country|region)\b/i;

const STRING_LITERAL_RE =
    /(?<![\w$])(['"`])(?:\\.|(?!\1)[^\\\n])*\1/;

/** export function/const/class/type/interface/enum … */
const EXPORT_RE =
    /^\s*export\s+(default\s+)?(async\s+)?(function|const|let|var|class|type|interface|enum|abstract|declare)\b/;

/** enum / type / interface declaration or member-ish lines. */
const ENUM_OR_TYPE_RE =
    /^\s*(export\s+)?(const\s+)?(enum|type|interface)\b|^\s*[A-Z][A-Z0-9_]*\s*[=,]|^\s*(case|when)\s+['"`]/;

/**
 * Object / payload field keys:
 *   foo: …   |  "foo": …  |  'foo': …  |  foo= …
 * (JSON, TS interfaces, object literals, form fields)
 */
const OBJECT_KEY_RE =
    /^\s*(?:['"`]?[A-Za-z_][\w.-]*['"`]?)\s*[:=]/;

const COMMENT_ONLY_RE = /^\s*(\/\/|#|\/\*|\*|<!--)/;

/** Pure import lines (reordering / path-only) — not boundary surface alone. */
const IMPORT_ONLY_RE =
    /^\s*(import|export\s+\*|export\s+\{|from\s+['"`]|require\s*\()/;

/**
 * Evaluate whether the changed files warrant a cross-repo boundary pass.
 *
 * @param changedFiles PR files with unified diffs (`patch` / `patchWithLinesStr`)
 */
export function evaluateCrossRepoBoundaryGate(
    changedFiles: Array<
        Pick<FileChange, 'filename' | 'patch' | 'status'> & {
            patchWithLinesStr?: string;
        }
    > | undefined | null,
): CrossRepoBoundaryGateResult {
    if (!changedFiles?.length) {
        return {
            activate: false,
            reasons: ['no changed files'],
            signals: [],
        };
    }

    const signals: CrossRepoGateSignal[] = [];
    const seen = new Set<string>(); // kind|file dedupe — one signal per kind per file

    const push = (
        kind: CrossRepoGateSignalKind,
        file: string,
        sample?: string,
    ) => {
        const key = `${kind}|${file}`;
        if (seen.has(key)) return;
        seen.add(key);
        signals.push({
            kind,
            file,
            sample: sample ? sample.slice(0, 120) : undefined,
        });
    };

    for (const file of changedFiles) {
        const filename = file.filename || '';
        if (!filename) continue;

        // Whole-file contract path (even if patch is sparse)
        if (CONTRACT_PATH_RE.test(filename)) {
            push('contract_path', filename);
        }

        const patch = file.patch || file.patchWithLinesStr || '';
        if (!patch) {
            // Added file without patch body — treat non-trivial new files as
            // potential surface only when the path already looked contractual.
            continue;
        }

        for (const rawLine of patch.split('\n')) {
            // Only added lines of the unified diff (not file headers +++).
            if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) {
                continue;
            }
            const line = rawLine.slice(1);
            if (!line.trim()) continue;
            if (COMMENT_ONLY_RE.test(line)) continue;
            if (IMPORT_ONLY_RE.test(line)) continue;

            const trimmed = line.trim();

            if (STRING_LITERAL_RE.test(line)) {
                // Ignore empty / whitespace-only / single-char noise.
                const lit = line.match(STRING_LITERAL_RE)?.[0] ?? '';
                const inner = lit.slice(1, -1);
                if (inner.trim().length >= 2) {
                    push('string_literal', filename, trimmed);
                }
            }

            if (EXPORT_RE.test(line)) {
                push('export', filename, trimmed);
            }

            if (ENUM_OR_TYPE_RE.test(line)) {
                push('enum_or_type', filename, trimmed);
            }

            // Object keys — only when the line looks like a property, not a
            // ternary / label. Require the key form and not pure control flow.
            if (
                OBJECT_KEY_RE.test(line) &&
                !/^\s*(if|for|while|switch|return|throw|else|try|catch)\b/.test(
                    line,
                )
            ) {
                push('object_key', filename, trimmed);
            }

            if (
                STATUS_STATE_RE.test(line) &&
                /[=:]/.test(line) &&
                (STRING_LITERAL_RE.test(line) ||
                    /\b[A-Z][A-Z0-9_]+\b/.test(line))
            ) {
                push('status_or_state', filename, trimmed);
            }
        }
    }

    if (signals.length === 0) {
        return {
            activate: false,
            reasons: [
                'diff has no boundary surface (no string literals, exports, enum/type members, payload keys, status values, or contract paths)',
            ],
            signals: [],
        };
    }

    // Summarize reasons for telemetry.
    const byKind = new Map<CrossRepoGateSignalKind, number>();
    for (const s of signals) {
        byKind.set(s.kind, (byKind.get(s.kind) || 0) + 1);
    }
    const reasons = [...byKind.entries()].map(
        ([kind, n]) => `${kind}×${n}`,
    );

    return {
        activate: true,
        reasons,
        signals,
    };
}

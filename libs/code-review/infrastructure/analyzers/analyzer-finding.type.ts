/**
 * A finding from the deterministic rule pack, normalized out of SARIF.
 *
 * Distinct from `CheckEvidence`, which is what the customer's own CI reported.
 * This is what Kody's own analyzer found, and it carries the provenance the
 * review needs to attribute a published finding to a rule rather than to the
 * model.
 */
export type AnalyzerFinding = {
    /** Rule that fired, e.g. "kodus-sqli-concat-go". */
    ruleId: string;
    /** Repo-relative path. */
    path: string;
    startLine: number;
    endLine: number;
    severity: 'error' | 'warning' | 'note';
    message: string;
    /** CWE identifier from the rule's metadata, when it declares one. */
    cwe?: string;
};

/** Lines a unified-diff patch ADDS, on the new side of the file. */
export function addedLinesFromPatch(patch: string | undefined): Set<number> {
    const added = new Set<number>();
    if (!patch) {
        return added;
    }

    let cursor = 0;
    for (const line of patch.split('\n')) {
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            cursor = parseInt(hunk[1], 10);
            continue;
        }
        if (line.startsWith('+')) {
            added.add(cursor);
            cursor++;
        } else if (line.startsWith('-')) {
            // Present only on the old side; does not advance the new cursor.
        } else {
            cursor++;
        }
    }

    return added;
}

/**
 * Parses opengrep/semgrep SARIF into findings.
 *
 * Rule ids carry the config directory as a prefix (`libs.code-review...
 * .kodus-sqli-concat-go`); only the tail identifies the rule.
 */
export function parseAnalyzerSarif(
    raw: string,
    repoRoot: string,
): AnalyzerFinding[] {
    let sarif: unknown;
    try {
        sarif = JSON.parse(raw);
    } catch {
        return [];
    }

    const runs = (sarif as { runs?: unknown[] })?.runs;
    if (!Array.isArray(runs)) {
        return [];
    }

    const findings: AnalyzerFinding[] = [];

    for (const run of runs) {
        const results = (run as { results?: unknown[] })?.results;
        if (!Array.isArray(results)) continue;

        for (const result of results) {
            const typed = result as {
                ruleId?: string;
                level?: string;
                message?: { text?: string };
                locations?: Array<{
                    physicalLocation?: {
                        artifactLocation?: { uri?: string };
                        region?: { startLine?: number; endLine?: number };
                    };
                }>;
            };

            const location = typed.locations?.[0]?.physicalLocation;
            if (!location) continue;

            let path = decodeURIComponent(
                location.artifactLocation?.uri ?? '',
            ).replace(/^file:\/\//, '');
            if (repoRoot && path.startsWith(repoRoot)) {
                path = path.slice(repoRoot.length).replace(/^\/+/, '');
            }
            if (!path) continue;

            const startLine = location.region?.startLine ?? 0;
            if (startLine <= 0) continue;

            findings.push({
                ruleId: (typed.ruleId ?? 'unknown').split('.').pop() ?? 'unknown',
                path,
                startLine,
                endLine: location.region?.endLine ?? startLine,
                severity:
                    typed.level === 'error'
                        ? 'error'
                        : typed.level === 'note'
                          ? 'note'
                          : 'warning',
                message: (typed.message?.text ?? '').replace(/\s+/g, ' ').trim(),
            });
        }
    }

    return findings;
}

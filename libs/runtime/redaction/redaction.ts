import RULES_FILE from './gitleaks-rules.json';

// The token-pattern pass of S-51, shared with the cell: the same rule data
// file (a curated subset of gitleaks' default rules, MIT; see its header)
// runs in apps/runtime-cell/internal/redact and here. The cell redacts what
// it knows before anything leaves it; the LLM gateway repeats this pass
// before the provider call. Replacement is one way: [redacted:<rule>].

interface RuleData {
    id: string;
    regex: string;
    caseInsensitive: boolean;
    secretGroup: number;
    keywords: string[];
    examples: string[];
    source: string;
}

export interface RedactionRule extends RuleData {
    pattern: RegExp;
}

export const REDACTION_RULES_SOURCE = (RULES_FILE as { source: { url: string; commit: string; license: string } }).source;

export const REDACTION_RULES: readonly RedactionRule[] = (RULES_FILE as { rules: RuleData[] }).rules.map((r) => ({
    ...r,
    // RE2 and ECMAScript read these the same; `d` gives the group offsets.
    pattern: new RegExp(r.regex, `g${r.caseInsensitive ? 'i' : ''}d`),
}));

export const redactionMarker = (rule: string) => `[redacted:${rule}]`;

export interface Redacted {
    text: string;
    count: number;
    /** Replacements by rule id. */
    byRule: Record<string, number>;
}

/** Runs every rule over the text, in file order. */
export function redactPatterns(text: string, rules: readonly RedactionRule[] = REDACTION_RULES): Redacted {
    const byRule: Record<string, number> = {};
    let count = 0;
    let out = text ?? '';
    for (const rule of rules) {
        if (rule.keywords.length) {
            const lower = out.toLowerCase();
            if (!rule.keywords.some((k) => lower.includes(k))) continue;
        }
        let n = 0;
        let last = 0;
        let built = '';
        rule.pattern.lastIndex = 0;
        for (const m of out.matchAll(rule.pattern)) {
            const span = rule.secretGroup > 0 ? m.indices?.[rule.secretGroup] : m.indices?.[0];
            if (!span || span[0] < last) continue;
            built += out.slice(last, span[0]) + redactionMarker(rule.id);
            last = span[1];
            n++;
        }
        if (n) {
            out = built + out.slice(last);
            byRule[rule.id] = (byRule[rule.id] ?? 0) + n;
            count += n;
        }
    }
    return { text: out, count, byRule };
}

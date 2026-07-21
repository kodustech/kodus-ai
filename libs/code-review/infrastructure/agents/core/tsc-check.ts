/**
 * code-review (domain) — a tsc ExecutableCheck for finder suggestions.
 *
 * Runs the project's TypeScript compiler ONCE (shared across every finding via
 * a constant cacheKey) and reads its diagnostics as an OBJECTIVE signal:
 *
 *   - tsc flags an error AT the finding's changed line  → corroborated: keep
 *     with HIGH confidence (the CompositeVerifier trusts this and skips the LLM;
 *     a compiler-confirmed defect is never dropped).
 *   - anything else (tsc clean, error elsewhere, tsc could not run) → LOW
 *     confidence, which defers to the LLM. It is a CORROBORATOR, not a refuter:
 *     tsc proving a file compiles does NOT make a logic/security finding false,
 *     so absence of a tsc error never drops a finding.
 *
 * Project-level `tsc --noEmit` (uses the repo's tsconfig) is used deliberately:
 * a single-file check without project context emits spurious module/type errors
 * and would falsely "corroborate" everything.
 */
import type { ExecutableCheck } from '@libs/agent-harness/infrastructure/verify/executable-verifier';
import { keptOpen } from '@libs/agent-harness/infrastructure/verify/executable-verifier';
import type { CommandResult } from '@libs/agent-harness/domain/contracts/command-runner.contract';
import type { Verdict } from '@libs/agent-harness/domain/contracts/verifier.contract';
import type { FinderSuggestion } from './finder.agent';

function isTypeScript(file: string | undefined): file is string {
    return !!file && /\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts');
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does the tsc output report an error anchored to `file` at `line`?
 *  Matches both `file(LINE,COL):` and `file:LINE:COL` diagnostic formats. */
function flagsLine(output: string, file: string, line: number): boolean {
    const f = escapeRegExp(file);
    return (
        new RegExp(`${f}\\(${line},\\d+\\):\\s*error TS\\d+`).test(output) ||
        new RegExp(`${f}:${line}:\\d+.*error TS\\d+`).test(output)
    );
}

export const tscCheck: ExecutableCheck<FinderSuggestion> = {
    command: (f) =>
        isTypeScript(f.relevantFile)
            ? 'npx tsc --noEmit --pretty false 2>&1 || true'
            : null,

    // Constant key: tsc -p checks the WHOLE project once; every TS finding reuses
    // that single run.
    cacheKey: (f) => (isTypeScript(f.relevantFile) ? 'tsc:project' : null),

    interpret: (f, r: CommandResult): Verdict => {
        const output = `${r.stdout}\n${r.stderr}`;
        const line = f.relevantLinesStart;

        if (line != null && flagsLine(output, f.relevantFile, line)) {
            return {
                keep: true,
                confidence: 'high',
                rationale: `tsc reports an error at ${f.relevantFile}:${line} — objectively corroborated.`,
                dimensions: [
                    {
                        name: 'tsc',
                        pass: false,
                        note: `error at ${f.relevantFile}:${line}`,
                    },
                ],
            };
        }

        // No error at the finding's line → tsc has no verdict here. Defer to the
        // LLM (fail open: never drop on absence of an objective signal).
        return keptOpen(
            'tsc did not flag the finding line — no objective signal, deferring to the LLM.',
        );
    },
};

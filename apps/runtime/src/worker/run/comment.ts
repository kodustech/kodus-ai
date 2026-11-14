import type { CheckOutcome, ProbeVerdict } from '@libs/runtime/run';

// The comment is built only from structured fields (ADR-052): verdicts,
// probe ids and entry points. Agent prose never reaches it.

const esc = (s: string) => s.replace(/[<>`|]/g, (c) => `&#${c.charCodeAt(0)};`).slice(0, 300);

export function buildComment(args: {
    check: CheckOutcome;
    findings: ProbeVerdict[];
    intended: ProbeVerdict[];
    uncovered: string[];
    probes: ProbeVerdict[];
    headSha: string;
    /** The Run halted on a canary (ADR-043). */
    securityEvent?: boolean;
    /** Recipe files the PR changes whose PR copy the Run never boots (S-19): fixed paths, never repo text. */
    recipeChangedInPr?: string[];
}): string {
    const lines = [`### Kody Runtime · ${esc(args.check.title)}`, '', `Tested at \`${args.headSha.slice(0, 12)}\`, base and PR replayed on the same image.`, ''];
    if (args.securityEvent) {
        lines.push('**Security event**: a decoy credential planted in the machine crossed a boundary, so the Run stopped. Entry points without a verdict were not verified.', '');
    }
    if (args.recipeChangedInPr?.length) {
        lines.push(`**Recipe changed**: this PR changes ${args.recipeChangedInPr.map((p) => `\`${esc(p)}\``).join(', ')}. Kody boots every pull request with the recipe from the base branch, so the PR's copy was not tested.`, '');
    }
    if (args.findings.length) {
        lines.push('**Regressions**', '', '| Entry point | Probe | Differs in |', '|---|---|---|');
        for (const f of args.findings) lines.push(`| ${esc(f.entryPoint)} | ${esc(f.probeId)} | ${esc((f.differingFields ?? []).join(', ') || f.findingKind || '')} |`);
        lines.push('');
    }
    if (args.intended.length) {
        lines.push('**Intended change**', '');
        for (const f of args.intended) lines.push(`- ${esc(f.entryPoint)} (${esc(f.probeId)})`);
        lines.push('');
    }
    const others = args.probes.filter((p) => p.verdict !== 'finding');
    if (others.length) {
        lines.push('| Entry point | Probe | Verdict |', '|---|---|---|');
        for (const p of others) lines.push(`| ${esc(p.entryPoint)} | ${esc(p.probeId)} | ${p.verdict} |`);
        lines.push('');
    }
    if (args.uncovered.length) lines.push(`Not verified: ${args.uncovered.map(esc).join(', ')}`);
    return lines.join('\n').trim();
}

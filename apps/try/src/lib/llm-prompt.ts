import type { ReviewIssue } from "./api";

export type PromptContext = {
    /** PR identifier shown in the prompt header (e.g. owner/repo#123). */
    prRef?: string;
    htmlUrl?: string;
};

/**
 * Build a self-contained prompt for the user to paste into Cursor / Claude
 * Code / ChatGPT. The shape is opinionated: file:line up top, the issue
 * description, then the suggested fix as a fenced block when present.
 */
export function buildLlmPromptForIssue(
    issue: ReviewIssue,
    ctx: PromptContext = {},
): string {
    const lineRef =
        issue.endLine && issue.endLine !== issue.line
            ? `${issue.line}-${issue.endLine}`
            : String(issue.line);

    const headerLines: string[] = [];
    if (ctx.prRef) headerLines.push(`PR: ${ctx.prRef}`);
    if (ctx.htmlUrl) headerLines.push(`Link: ${ctx.htmlUrl}`);
    headerLines.push(`File: ${issue.file}`);
    headerLines.push(`Line: ${lineRef}`);
    if (issue.severity) headerLines.push(`Severity: ${issue.severity}`);
    if (issue.category) headerLines.push(`Category: ${issue.category}`);

    const sections: string[] = [
        "I'm reviewing a code change and got the following feedback from Kodus. Apply the fix below in this codebase.",
        headerLines.join("\n"),
        `Problem:\n${issue.message.trim()}`,
    ];

    if (issue.suggestion?.trim()) {
        const fenced = isLikelyCode(issue.suggestion)
            ? "```\n" + issue.suggestion.trim() + "\n```"
            : issue.suggestion.trim();
        sections.push(`Suggested fix:\n${fenced}`);
    }

    sections.push(
        "Apply this fix to the file above. If anything is ambiguous, ask before editing.",
    );

    return sections.join("\n\n");
}

export function buildLlmPromptForFile(
    file: string,
    issues: ReviewIssue[],
    ctx: PromptContext = {},
): string {
    const intro = [
        `I'm reviewing a code change and got the following feedback from Kodus on \`${file}\`. Apply the fixes below.`,
    ];
    if (ctx.prRef) intro.push(`PR: ${ctx.prRef}`);
    if (ctx.htmlUrl) intro.push(`Link: ${ctx.htmlUrl}`);

    const blocks = issues.map((issue, idx) => {
        const lineRef =
            issue.endLine && issue.endLine !== issue.line
                ? `${issue.line}-${issue.endLine}`
                : String(issue.line);
        const parts: string[] = [
            `### Issue ${idx + 1} — line ${lineRef}${
                issue.severity ? ` (${issue.severity})` : ""
            }`,
            issue.message.trim(),
        ];
        if (issue.suggestion?.trim()) {
            const fenced = isLikelyCode(issue.suggestion)
                ? "```\n" + issue.suggestion.trim() + "\n```"
                : issue.suggestion.trim();
            parts.push(`Suggested fix:\n${fenced}`);
        }
        return parts.join("\n\n");
    });

    return [
        intro.join("\n"),
        ...blocks,
        "Apply these fixes. If anything is ambiguous, ask before editing.",
    ].join("\n\n");
}

function isLikelyCode(text: string): boolean {
    if (!text.includes("\n")) return false;
    return /^\s{2,}\S/m.test(text) || /[{};]\s*$/m.test(text);
}

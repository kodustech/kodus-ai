import type { PromptContext, ReviewIssue } from "./types";

export type { PromptContext };

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

/**
 * A tighter, imperative handoff prompt aimed at an in-editor coding agent
 * (Cursor / Claude Code) rather than a chat. Leads with the exact location so
 * the agent can jump straight to the edit, states the tier + category, then the
 * problem, and fences the suggested change when we have one.
 */
export function buildAgentPromptForIssue(
    issue: ReviewIssue,
    ctx: PromptContext = {},
): string {
    const lineRef =
        issue.endLine && issue.endLine !== issue.line
            ? `${issue.line}-${issue.endLine}`
            : String(issue.line);

    const severity = (issue.severity || "").trim();
    const category = issue.category?.trim();
    // "high security issue" / "high issue" / "issue" — no double spaces.
    const descriptor = [severity, category, "issue"]
        .filter(Boolean)
        .join(" ");

    const sections: string[] = [
        `In ${issue.file} around lines ${lineRef}, fix this ${descriptor}: ${issue.message.trim()}`,
    ];

    if (issue.suggestion?.trim()) {
        sections.push(
            "Suggested change:\n```\n" + issue.suggestion.trim() + "\n```",
        );
    }

    if (ctx.prRef) sections.push(`Context: ${ctx.prRef}`);

    sections.push(
        "Keep the change minimal and add/adjust tests if relevant.",
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

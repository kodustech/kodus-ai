import { baseVersionLabel } from "./base-version";
import type { BootFailureView } from "./boot-failure";
import type { CodeRef } from "./code-ref";
import type { Finding } from "./findings";
import {
    formatOffset,
    LANE_KIND_NOUN,
    requestOnlyStatusDiffers,
} from "./replay-lanes";
import { buildResponseDiff } from "./response-diff";
import { code, strong, type RichText } from "./rich-text";

// "What happened", at the top of a finding: one sentence each for the
// answers, the first difference and the code, built from the structured
// fields only (the answers, responseDiff, lanes, diffRef, the boot
// failure). No model text reaches it; values are the cell's, redacted.

const known = (answer: string) =>
    answer !== "not recorded" && answer !== "running";

/** At most this many fields are named in the sentence; the table has them all. */
const FIELDS_IN_SENTENCE = 2;

const answersSentence = (f: Finding): RichText | undefined => {
    const route = code(f.route);
    const baseLabel = f.baseLabel ?? baseVersionLabel();
    const { base, pr } = f;
    if (known(base.answer) && known(pr.answer) && base.answer !== pr.answer)
        return [
            route,
            " answered ",
            strong(pr.answer),
            " on this PR and ",
            strong(base.answer),
            ` on ${baseLabel}.`,
        ];
    const diff = buildResponseDiff(f.responseDiff);
    const both =
        known(base.answer) && known(pr.answer)
            ? [route, " answered ", strong(pr.answer), " on both"]
            : [route, " answered differently"];
    if (diff) {
        const shown = diff.rows.slice(0, FIELDS_IN_SENTENCE);
        const parts: RichText = [...both, ", but "];
        shown.forEach((row, i) => {
            if (i > 0) parts.push(i === shown.length - 1 ? " and " : ", ");
            parts.push(code(row.path));
            if (row.change === "removed")
                parts.push(
                    ` is gone on this PR (${baseLabel}: `,
                    strong(row.base!),
                    ")",
                );
            else if (row.change === "added")
                parts.push(" is new on this PR (", strong(row.pr!), ")");
            else
                parts.push(
                    " went from ",
                    strong(row.base ?? ""),
                    ` on ${baseLabel} to `,
                    strong(row.pr ?? ""),
                );
        });
        const more = diff.rows.length - shown.length;
        parts.push(
            more > 0
                ? `, and ${more} more field${more === 1 ? "" : "s"} differ.`
                : ".",
        );
        return parts;
    }
    const fields = f.differingFields.filter((x) => x !== "status");
    if (fields.length) {
        const parts: RichText = [...both, ", but "];
        fields.forEach((field, i) => {
            if (i > 0) parts.push(i === fields.length - 1 ? " and " : ", ");
            parts.push(code(field));
        });
        parts.push(fields.length === 1 ? " differs." : " differ.");
        return parts;
    }
    return undefined;
};

const firstDifferenceSentence = (f: Finding): RichText | undefined => {
    const baseLabel = f.baseLabel ?? baseVersionLabel();
    const fd = f.lanes?.firstDifference;
    // The answer is the first difference: the answers sentence already says it.
    if (
        !fd ||
        fd.kind === "response" ||
        (f.lanes && requestOnlyStatusDiffers(f.lanes))
    )
        return undefined;
    const noun = LANE_KIND_NOUN[fd.kind];
    if (fd.pr)
        return [
            "First difference: ",
            noun,
            " ",
            code(fd.pr.label),
            ` at ${formatOffset(fd.pr.at)}`,
            fd.base
                ? ` (${baseLabel}: `
                : ` on this PR, with none on ${baseLabel}.`,
            ...(fd.base ? [code(fd.base.label), ")."] : []),
        ];
    if (fd.base)
        return [
            `First difference: ${baseLabel}'s `,
            noun,
            " ",
            code(fd.base.label),
            ` at ${formatOffset(fd.base.at)} has no match on this PR.`,
        ];
    return undefined;
};

/** The finding's story, sentence by sentence; empty when the record holds too little to say it. */
export const whatHappened = (
    f: Finding,
    extra: { codeRef?: CodeRef; bootFailure?: BootFailureView } = {},
): RichText[] => {
    const baseLabel = f.baseLabel ?? baseVersionLabel();
    const out: RichText[] = [];
    if (f.boot) {
        const boot =
            extra.bootFailure?.side === "pr" ? extra.bootFailure : undefined;
        out.push(
            boot
                ? [
                      `${baseLabel} booted and this PR did not: ${boot.title.replace(/\.$/, "")}.`,
                  ]
                : [`${baseLabel} booted and this PR did not.`],
        );
    } else if (f.destabilizes) {
        out.push([
            "The machine failed on this PR while ",
            code(f.route),
            ` ran, and stayed up on ${baseLabel}.`,
        ]);
    } else {
        const answers = answersSentence(f);
        if (answers) out.push(answers);
    }
    const first = firstDifferenceSentence(f);
    if (first) out.push(first);
    if (extra.codeRef)
        out.push([
            "Changed in ",
            code(extra.codeRef.label, extra.codeRef.href),
            ".",
        ]);
    return out;
};

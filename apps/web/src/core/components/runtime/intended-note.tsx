import Link from "next/link";
import { codeRefOf } from "@services/runtime/model/code-ref";
import type { Finding } from "@services/runtime/model/findings";

/**
 * Why an intended finding is not a regression: the values this PR's diff
 * swaps (main's and the PR's, with the added line), or the test that already
 * existed on main and expects the change.
 */
export const IntendedNote = ({
    finding,
    pullRequestUrl,
}: {
    finding: Pick<Finding, "intendedBy" | "intendedChange" | "pr">;
    pullRequestUrl?: string;
}) => {
    const changes = finding.intendedChange ?? [];
    if (finding.intendedBy !== "diff" || !changes.length) {
        return (
            <p className="text-text-secondary text-sm" role="note">
                Kody read this change as what the PR means to do: a test that
                already existed on main expects it, so it is not counted as a
                regression.
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-1 text-sm" role="note">
            <p className="text-text-secondary">
                Kody read this change as what the PR means to do: this PR&apos;s
                diff changes exactly these values, so it is not counted as a
                regression.
            </p>
            <ul className="flex flex-col gap-1">
                {changes.map((c, i) => {
                    const ref = codeRefOf(
                        { file: c.file, line: c.line },
                        { url: pullRequestUrl, headSha: finding.pr.sha },
                    );
                    return (
                        <li key={i} className="text-text-primary min-w-0">
                            <code className="font-mono break-all">
                                {c.base}
                            </code>
                            <span className="text-text-tertiary">
                                {" "}
                                on main →{" "}
                            </span>
                            <code className="font-mono break-all">{c.pr}</code>
                            <span className="text-text-tertiary">
                                {" "}
                                on this PR ·{" "}
                            </span>
                            {ref?.href ? (
                                <Link
                                    href={ref.href}
                                    className="text-primary-light font-mono underline-offset-2 hover:underline">
                                    {ref.label}
                                </Link>
                            ) : (
                                <span className="text-text-secondary font-mono">
                                    {ref?.label}
                                </span>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};

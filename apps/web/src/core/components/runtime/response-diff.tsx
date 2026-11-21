import type { ResponseDiff } from "@services/runtime/contracts";
import { baseVersionLabel } from "@services/runtime/model/base-version";
import type { Tone } from "@services/runtime/labels";
import {
    buildResponseDiff,
    RESPONSE_DIFF_CHANGE_LABEL,
    type ResponseDiffChange,
} from "@services/runtime/model/response-diff";
import { cn } from "src/core/utils/components";

import { StatusChip } from "./status-chip";

const CHANGE_TONE: Record<ResponseDiffChange, Tone> = {
    removed: "danger",
    added: "info",
    changed: "alert",
};

const Value = ({ value, pr }: { value?: string; pr?: boolean }) =>
    value === undefined ? (
        <span className="text-text-tertiary">
            <span aria-hidden>—</span>
            <span className="sr-only">absent</span>
        </span>
    ) : (
        <span
            className={cn(
                "font-mono break-all whitespace-pre-wrap",
                pr ? "text-text-primary" : "text-text-secondary",
            )}>
            {value}
        </span>
    );

/** The fields of the answer that differ: field, main, this PR. Nothing when the verdict carries none. */
export const ResponseDiffTable = ({
    diff,
    baseLabel = baseVersionLabel(),
}: {
    diff?: ResponseDiff;
    baseLabel?: string;
}) => {
    const view = buildResponseDiff(diff);
    if (!view) return null;
    return (
        <div className="bg-card-lv2 flex flex-col gap-2 rounded-xl p-4">
            <table className="w-full table-fixed border-collapse text-left text-xs">
                <caption className="text-text-primary mb-2 text-left text-sm font-medium">
                    Fields that differ in the answer
                </caption>
                <thead>
                    <tr className="text-text-tertiary">
                        <th scope="col" className="w-[38%] pb-1 font-normal">
                            Field
                        </th>
                        <th scope="col" className="pb-1 font-normal">
                            {baseLabel}
                        </th>
                        <th scope="col" className="pb-1 font-normal">
                            this PR
                        </th>
                    </tr>
                </thead>
                <tbody className="font-mono">
                    {view.rows.map((row) => (
                        <tr
                            key={row.path}
                            className="border-card-lv3 border-t align-top">
                            <th scope="row" className="py-1.5 pr-2 font-normal">
                                <div className="flex flex-col items-start gap-1">
                                    <span className="text-text-primary font-mono break-all">
                                        {row.path}
                                    </span>
                                    <StatusChip
                                        tone={CHANGE_TONE[row.change]}
                                        className="font-sans">
                                        {RESPONSE_DIFF_CHANGE_LABEL[row.change]}
                                    </StatusChip>
                                </div>
                            </th>
                            <td className="py-1.5 pr-2">
                                <Value value={row.base} />
                            </td>
                            <td className="py-1.5">
                                <Value value={row.pr} pr />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {view.truncated && (
                <p className="text-text-tertiary text-xs">
                    Only the first fields are kept; the raw response has the
                    rest.
                </p>
            )}
        </div>
    );
};

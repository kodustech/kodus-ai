"use client";

import { useId, useState } from "react";
import { formatUtcClock } from "@services/runtime/format";
import {
    bootTailPreview,
    type BootFailureLine,
    type BootFailureView,
} from "@services/runtime/model/boot-failure";
import { cn } from "src/core/utils/components";

// The boot failure as a terminal (the Run log's panel: the page ground sunk
// into the card, status hues for the error). The lines are the cell's own,
// redacted; they are text, never markup.

const FOCUS =
    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-3";

const TailLine = ({ line }: { line: BootFailureLine }) => (
    <li
        className={cn(
            "px-3 font-mono break-words whitespace-pre-wrap",
            line.error
                ? "bg-danger/15 text-danger border-danger border-l-2"
                : "text-text-primary",
        )}>
        {line.error && <span className="sr-only">Error: </span>}
        {line.text}
    </li>
);

export const BootFailurePanel = ({ failure }: { failure: BootFailureView }) => {
    const [all, setAll] = useState(false);
    const listId = useId();
    const preview = bootTailPreview(failure);
    const lines = all ? failure.lines : preview;
    const hidden = failure.lines.length - preview.length;
    return (
        <div className="bg-background text-review flex flex-col gap-2 overflow-hidden rounded-xl py-3 font-mono leading-6">
            <div className="flex flex-col gap-0.5 px-3">
                <span className="text-danger font-mono font-semibold break-words">
                    <span aria-hidden>✕ </span>
                    {failure.title}
                </span>
                <span className="text-text-secondary font-mono text-xs">
                    {failure.sideLabel}
                    {failure.kindLabel && ` · ${failure.kindLabel}`}
                    {failure.at && (
                        <>
                            {" · "}
                            <time dateTime={failure.at}>
                                {formatUtcClock(failure.at)} UTC
                            </time>
                        </>
                    )}
                </span>
            </div>
            {failure.errorLine && !failure.errorInTail && (
                <p className="bg-danger/15 text-danger border-danger mx-0 border-l-2 px-3 font-mono break-words whitespace-pre-wrap">
                    <span className="sr-only">Error: </span>
                    {failure.errorLine}
                </p>
            )}
            {lines.length > 0 && (
                <ol
                    id={listId}
                    aria-label={`Last log lines of ${failure.sideLabel}`}
                    className="text-review">
                    {lines.map((l) => (
                        <TailLine key={l.key} line={l} />
                    ))}
                </ol>
            )}
            {hidden > 0 && (
                <button
                    type="button"
                    aria-expanded={all}
                    aria-controls={listId}
                    onClick={() => setAll((v) => !v)}
                    className={cn(
                        "text-text-secondary hover:text-text-primary mx-3 inline-flex min-h-11 w-fit items-center font-sans text-sm",
                        FOCUS,
                    )}>
                    {all
                        ? "Show only the last lines"
                        : `Show all ${failure.lines.length} lines the machine kept`}
                </button>
            )}
        </div>
    );
};

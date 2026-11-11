"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { toast } from "@components/ui/toaster/use-toast";
import {
    FIX_PROMPT_MAX_ISSUES,
    getIssuesFixPrompt,
} from "@services/issues/fetch";
import { CheckIcon, CopyIcon } from "lucide-react";
import { ClipboardHelpers } from "src/core/utils/clipboard";

/**
 * Copies a prompt that hands the given issues to the developer's own coding
 * agent (Claude Code, Cursor, Codex); the API builds it. The request runs
 * inside a ClipboardItem so the browser still counts the copy as part of the
 * click; where that is missing, the text is copied once it arrives.
 */
export const CopyFixPromptButton = ({
    ids,
    label = "Copy fix prompt",
    size = "xs",
}: {
    ids: string[];
    label?: string;
    size?: "xs" | "sm";
}) => {
    const [state, setState] = useState<"idle" | "copying" | "copied">("idle");

    const copy = async () => {
        setState("copying");
        const request = getIssuesFixPrompt(ids).then((result) => {
            if (!result.prompt) throw new Error("No issue could be included");
            return result;
        });

        try {
            if (
                typeof ClipboardItem !== "undefined" &&
                navigator.clipboard?.write
            ) {
                await navigator.clipboard.write([
                    new ClipboardItem({
                        "text/plain": request.then(
                            (r) => new Blob([r.prompt], { type: "text/plain" }),
                        ),
                    }),
                ]);
            } else {
                const { prompt } = await request;
                if (!ClipboardHelpers.copyTextToClipboard(prompt)) {
                    await navigator.clipboard.writeText(prompt);
                }
            }

            const { included, skipped } = await request;
            const capped = ids.length > FIX_PROMPT_MAX_ISSUES;
            toast({
                variant: "success",
                title: `Fix prompt copied (${included.length} ${included.length === 1 ? "issue" : "issues"})`,
                description: [
                    "Paste it into your coding agent.",
                    capped
                        ? `Only the first ${FIX_PROMPT_MAX_ISSUES} are in it.`
                        : "",
                    skipped.length
                        ? `${skipped.length} left out: you cannot read them.`
                        : "",
                ]
                    .filter(Boolean)
                    .join(" "),
            });
            setState("copied");
            setTimeout(() => setState("idle"), 1500);
        } catch {
            toast({
                variant: "danger",
                title: "We couldn't copy the fix prompt",
                description: "Try again.",
            });
            setState("idle");
        }
    };

    return (
        <Button
            size={size}
            variant="helper"
            loading={state === "copying"}
            disabled={ids.length === 0}
            leftIcon={state === "copied" ? <CheckIcon /> : <CopyIcon />}
            onClick={copy}>
            {state === "copied" ? "Copied" : label}
        </Button>
    );
};

"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useToast } from "@components/ui/toaster/use-toast";
import { Check, Share2 } from "lucide-react";

/**
 * Copies the current cockpit URL — with every filter (tab, date range,
 * repository, and the in-card filters synced via `useShallowParam`) — so
 * a teammate opens the exact same view. The URL is always current because
 * the filters push/replace it as they change.
 */
export const ShareViewButton = () => {
    const { toast } = useToast();
    const [copied, setCopied] = useState(false);

    const copyLink = async () => {
        const url = window.location.href;

        try {
            await navigator.clipboard.writeText(url);
        } catch {
            // navigator.clipboard requires a secure context — self-hosted
            // instances served over plain http (non-localhost) block it.
            // Fall back to a throwaway textarea + execCommand so the
            // button still works there.
            const textarea = document.createElement("textarea");
            textarea.value = url;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
        }

        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast({
            variant: "success",
            description: "View link copied — it opens this exact dashboard.",
        });
    };

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    size="icon-md"
                    variant="helper"
                    aria-label="Copy link to this view"
                    onClick={copyLink}>
                    {copied ? (
                        <Check className="text-success" />
                    ) : (
                        <Share2 />
                    )}
                </Button>
            </TooltipTrigger>
            <TooltipContent>
                {copied ? "Copied!" : "Copy link to this view"}
            </TooltipContent>
        </Tooltip>
    );
};

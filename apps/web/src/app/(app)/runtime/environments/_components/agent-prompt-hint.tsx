"use client";

import { Button } from "@components/ui/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { toast } from "@components/ui/toaster/use-toast";
import { agentPrompt } from "@services/runtime/model/agent-prompt";
import { BotIcon, CopyIcon } from "lucide-react";

/**
 * The other way to a recipe, said once for the page: the developer's own
 * coding agent writes `.kodus/workspace.yaml` from a checkout where it already
 * runs the project, and opens the pull request. Set up with Kody stays the
 * row action; this is for teams that prefer their agent, or a repository Kody
 * could not boot.
 */
export const AgentPromptHint = () => {
    const prompt = agentPrompt("this repository");
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(prompt);
            toast({
                variant: "success",
                description:
                    "Prompt copied. Paste it in your coding agent, inside the repository.",
            });
        } catch {
            toast({ variant: "danger", title: "Couldn't copy the prompt" });
        }
    };
    return (
        <div className="text-text-tertiary -mt-3 flex flex-wrap items-center gap-1 text-xs">
            Rather have your own coding agent write the setup file?
            <Popover>
                <PopoverTrigger asChild>
                    <Button
                        size="xs"
                        variant="cancel"
                        leftIcon={<BotIcon />}
                        className="text-primary-light">
                        Get a prompt for Claude Code, Cursor or Codex
                    </Button>
                </PopoverTrigger>
                <PopoverContent
                    align="start"
                    className="flex w-[30rem] flex-col gap-3 p-4">
                    <span className="text-text-secondary text-xs">
                        Paste it in your coding agent with the repository open.
                        The agent writes{" "}
                        <code className="font-mono">.kodus/workspace.yaml</code>{" "}
                        (how to install, build and start the app), boots the app
                        with it to check it answers, and opens a pull request.
                        Once it is merged, Kody boots from it. Useful when your
                        agent already runs the project, or when Kody could not
                        set a repository up.
                    </span>
                    <pre
                        aria-label="Prompt"
                        className="bg-card-lv2 text-text-secondary text-2xs max-h-48 overflow-auto rounded-lg p-3 font-mono leading-relaxed whitespace-pre-wrap">
                        {prompt}
                    </pre>
                    <Button
                        size="sm"
                        variant="primary"
                        leftIcon={<CopyIcon />}
                        className="self-end"
                        onClick={copy}>
                        Copy prompt
                    </Button>
                </PopoverContent>
            </Popover>
        </div>
    );
};

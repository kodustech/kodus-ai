"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { useSuspenseKodyRulesCheckSyncStatus } from "@services/kodyRules/hooks";
import { XIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { useCodeReviewConfig } from "../../../../_components/context";
import { useCodeReviewRouteParams } from "../../../../_hooks";

const dismissedKey = (teamId: string) =>
    `kody-rules:removed-onboarding-imports-dismissed:${teamId}`;

const DISMISS_EVENT = "kody-rules:removed-onboarding-imports-dismissed";

const subscribe = (onChange: () => void) => {
    window.addEventListener("storage", onChange);
    window.addEventListener(DISMISS_EVENT, onChange);
    return () => {
        window.removeEventListener("storage", onChange);
        window.removeEventListener(DISMISS_EVENT, onChange);
    };
};

/**
 * Rules the onboarding import made from coding-agent files were removed when
 * those files stopped becoming rules. Offers the setting that reads the same
 * files during review, per repository, until it is on or dismissed.
 */
export const RemovedOnboardingImportsNotice = ({
    onOpenConfiguration,
}: {
    onOpenConfiguration: () => void;
}) => {
    const config = useCodeReviewConfig();
    const { teamId } = useSelectedTeamId();
    const { repositoryId } = useCodeReviewRouteParams();
    const syncStatus = useSuspenseKodyRulesCheckSyncStatus({
        teamId,
        repositoryId,
    });

    // Treated as dismissed on the server, so nothing renders until the
    // client has read localStorage.
    const dismissed = useSyncExternalStore(
        subscribe,
        () => localStorage.getItem(dismissedKey(teamId)) === "1",
        () => true,
    );

    const count = syncStatus.removedOnboardingImports ?? 0;
    if (count === 0 || config?.repoInstructionsEnabled?.value || dismissed) {
        return null;
    }

    const dismiss = () => {
        localStorage.setItem(dismissedKey(teamId), "1");
        window.dispatchEvent(new Event(DISMISS_EVENT));
    };

    return (
        <Card
            color="lv1"
            className="flex flex-row items-center justify-between gap-6 p-5">
            <div className="flex flex-col gap-1">
                <span className="text-text-primary text-sm font-semibold">
                    {count} rule{count === 1 ? " was" : "s were"} removed: they
                    came from coding-agent files during onboarding
                </span>
                <span className="text-text-secondary text-sm">
                    Kody no longer turns CLAUDE.md, AGENTS.md or .cursor/rules
                    into rules. Turn on{" "}
                    <strong>Use coding-agent instructions in reviews</strong>{" "}
                    and Kody reads those files in each repository&apos;s reviews
                    instead. To get the removed rules back, contact support.
                </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <Button
                    size="sm"
                    variant="primary"
                    onClick={onOpenConfiguration}>
                    Open configuration
                </Button>
                <Button
                    size="icon-sm"
                    variant="cancel"
                    aria-label="Dismiss"
                    onClick={dismiss}>
                    <XIcon />
                </Button>
            </div>
        </Card>
    );
};

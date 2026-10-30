"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { createOrUpdateOrganizationParameter } from "@services/organizationParameters/fetch";
import {
    OrganizationParametersConfigKey,
    type OrganizationParametersAutoAssignConfig,
} from "@services/parameters/types";
import { useSuspenseGetConnections } from "@services/setup/hooks";
import { UserPlusIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { assignOrDeassignUserLicenseAction } from "../../_actions/assign-or-deassign-license";

/**
 * Resolves the connected platform the same way the per-row toggle does, so the
 * escape hatch stays available even while the member list itself is failing.
 */
export const AssignByGitIdButton = ({
    onAssigned,
    autoLicenseAssignmentConfig,
}: {
    onAssigned: () => void;
    autoLicenseAssignmentConfig?: OrganizationParametersAutoAssignConfig;
}) => {
    const { teamId } = useSelectedTeamId();
    const connections = useSuspenseGetConnections(teamId);

    const gitTool = connections
        .find((connection) => connection.category === "CODE_MANAGEMENT")
        ?.platformName.toLowerCase();

    if (!gitTool) return null;

    return (
        <Button
            size="sm"
            variant="helper"
            leftIcon={<UserPlusIcon />}
            onClick={() =>
                magicModal.show(() => (
                    <AssignByGitIdModal
                        teamId={teamId}
                        gitTool={gitTool}
                        onAssigned={onAssigned}
                        autoLicenseAssignmentConfig={
                            autoLicenseAssignmentConfig
                        }
                    />
                ))
            }>
            Assign by git ID
        </Button>
    );
};

/**
 * Last resort for assigning a seat when the member list does not contain the
 * identity that needs one — a code platform we could not reach, an account
 * whose provider exposes no member listing, or an app that authors pull
 * requests. Without it a purchased seat can be impossible to assign at all.
 */
export const AssignByGitIdModal = ({
    teamId,
    gitTool,
    onAssigned,
    autoLicenseAssignmentConfig,
}: {
    teamId: string;
    gitTool: string;
    onAssigned: () => void;
    autoLicenseAssignmentConfig?: OrganizationParametersAutoAssignConfig;
}) => {
    const [gitId, setGitId] = useState("");
    const [error, setError] = useState<string | undefined>();

    const trimmedGitId = gitId.trim();

    const [assign, { loading: isAssigning }] = useAsyncAction(async () => {
        setError(undefined);

        try {
            const result = await assignOrDeassignUserLicenseAction({
                teamId,
                user: {
                    git_id: trimmedGitId,
                    git_tool: gitTool,
                    licenseStatus: "active",
                },
                userName: trimmedGitId,
            });

            // A refused seat comes back in the payload rather than as a thrown
            // error, so an unchecked call would look like a success. The most
            // likely refusal here is simply having no seat left.
            const failure = result?.failures?.[0];
            if (failure) {
                setError(
                    typeof failure?.error === "string"
                        ? failure.error
                        : "That seat could not be assigned.",
                );
                return;
            }

            // This identity is one the member list could not show, so record
            // it: otherwise the seat-revocation cron reads its absence as
            // "left the organization" and reclaims the seat days later.
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.AUTO_LICENSE_ASSIGNMENT,
                {
                    enabled: false,
                    ignoredUsers: [],
                    ...autoLicenseAssignmentConfig,
                    manuallyAssignedIds: Array.from(
                        new Set([
                            ...(autoLicenseAssignmentConfig?.manuallyAssignedIds ??
                                []),
                            trimmedGitId,
                        ]),
                    ),
                },
            ).catch(() => {
                // The seat is already granted; losing the marker only means the
                // cron may later propose it, which the admin can decline.
            });

            toast({
                variant: "success",
                title: `Seat assigned to ${trimmedGitId}`,
            });

            magicModal.hide();
            onAssigned();
        } catch {
            setError("Failed to assign the seat. Please try again.");
        }
    });

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Assign a seat by git ID</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <p className="text-text-secondary text-pretty text-sm">
                        Use this when the person or app you need to license does
                        not appear in the list above. Enter the identifier your
                        code platform uses for them — the same value that
                        appears as the author of their pull requests.
                    </p>

                    <FormControl.Root>
                        <FormControl.Label htmlFor="git-id">
                            Git ID
                        </FormControl.Label>

                        <FormControl.Input>
                            <Input
                                id="git-id"
                                value={gitId}
                                error={error}
                                autoFocus
                                placeholder="e.g. 1234567"
                                onChange={(event) => {
                                    setGitId(event.target.value);
                                    setError(undefined);
                                }}
                            />
                        </FormControl.Input>

                        <FormControl.Error>{error}</FormControl.Error>

                        <FormControl.Helper>
                            Assigning a seat here also lets Kody review pull
                            requests opened by this identity, even if it is on
                            your ignored authors list.
                        </FormControl.Helper>
                    </FormControl.Root>
                </div>

                <DialogFooter>
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={() => magicModal.hide()}>
                        Cancel
                    </Button>

                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<UserPlusIcon />}
                        loading={isAssigning}
                        disabled={!trimmedGitId}
                        onClick={() => assign()}>
                        Assign seat
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

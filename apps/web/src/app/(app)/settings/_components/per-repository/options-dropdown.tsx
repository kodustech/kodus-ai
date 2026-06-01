"use client";

import { Button } from "@components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { magicModal } from "@components/ui/magic-modal";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useSuspenseGetCodeReviewParameter } from "@services/parameters/hooks";
import { EllipsisIcon, FolderPenIcon, TrashIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import type { CodeReviewRepositoryConfig } from "../../code-review/_types";
import { AddRepoModal } from "../copy-settings-modal";
import { DeleteRepoConfigModal } from "./delete-config-modal";

export const SidebarRepositoryOrDirectoryDropdown = (props: {
    repository: Pick<CodeReviewRepositoryConfig, "id" | "name" | "isSelected">;
    directory?: Pick<
        NonNullable<CodeReviewRepositoryConfig["directories"]>[number],
        "id" | "name" | "folders"
    >;
}) => {
    const { teamId } = useSelectedTeamId();
    const { configValue } = useSuspenseGetCodeReviewParameter(teamId);
    const canDelete = usePermission(
        Action.Delete,
        ResourceType.CodeReviewSettings,
    );
    const canUpdate = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
    );

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="cancel">
                    <EllipsisIcon className="size-5!" />
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" sideOffset={-6}>
                {props.directory && (
                    <DropdownMenuItem
                        className="text-[13px] leading-none"
                        leftIcon={<FolderPenIcon className="size-4!" />}
                        disabled={!canUpdate}
                        onClick={() => {
                            magicModal.show(() => (
                                <AddRepoModal
                                    repositories={
                                        configValue?.repositories ?? []
                                    }
                                    editGroup={{
                                        repositoryId: props.repository.id,
                                        directoryId: props.directory!.id,
                                        initialPaths:
                                            props.directory!.folders?.map(
                                                (f) => f.path,
                                            ) ?? [],
                                    }}
                                />
                            ));
                        }}>
                        Edit directories
                    </DropdownMenuItem>
                )}

                <DropdownMenuItem
                    className="text-danger text-[13px] leading-none"
                    leftIcon={<TrashIcon className="size-4!" />}
                    disabled={!canDelete}
                    onClick={() => {
                        magicModal.show(() => (
                            <DeleteRepoConfigModal
                                repository={props.repository}
                                directory={props.directory}
                            />
                        ));
                    }}>
                    Delete configuration
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

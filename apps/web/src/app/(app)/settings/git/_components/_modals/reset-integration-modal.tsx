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
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { useTimeout } from "@hooks/use-timeout";
import {
    deleteIntegration,
    deleteIntegrationAndRepositories,
} from "@services/codeManagement/fetch";
import { INTEGRATION_CONFIG } from "@services/integrations/integrationConfig";
import { PARAMETERS_PATHS } from "@services/parameters";
import { ParametersConfigKey } from "@services/parameters/types";
import { IntegrationCategory } from "src/core/types";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

type DeleteMemberModalProps = {
    teamId: string;
    platformName: string;
};

export const ResetIntegrationModal = ({
    teamId,
    platformName,
}: DeleteMemberModalProps) => {
    const [enabled, setEnabled] = useState(false);
    const { invalidateQueries, resetQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();

    useTimeout(() => {
        setEnabled(true);
    }, 3000);

    const [handleDelete, { loading }] = useAsyncAction(async () => {
        magicModal.lock();

        try {
            await deleteIntegration(teamId);

            toast({
                variant: "success",
                title: "Integration deleted successfully",
            });

            await Promise.all([
                invalidateQueries({
                    type: "all",
                    queryKey: generateQueryKey(
                        INTEGRATION_CONFIG.GET_INTEGRATION_CONFIG_BY_CATEGORY,
                        {
                            params: {
                                teamId: teamId,
                                integrationCategory:
                                    IntegrationCategory.CODE_MANAGEMENT,
                            },
                        },
                    ),
                }),
                resetQueries({
                    type: "all",
                    queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                        params: {
                            key: ParametersConfigKey.CENTRALIZED_CONFIG,
                            teamId,
                        },
                    }),
                }),
                revalidateServerSidePath("/settings/git"),
            ]);
        } catch (error) {
            toast({
                variant: "warning",
                title: "Error deleting integration",
                description: "Please try again later",
            });
        } finally {
            magicModal.hide();
        }
    });

    const [
        handleDeleteIntegrationAndRepositories,
        { loading: loadingDeleteAll },
    ] = useAsyncAction(async () => {
        magicModal.lock();

        try {
            await deleteIntegrationAndRepositories(teamId);

            toast({
                variant: "success",
                title: "Integration and repositories deleted successfully",
            });

            await Promise.all([
                invalidateQueries({
                    type: "all",
                    queryKey: generateQueryKey(
                        INTEGRATION_CONFIG.GET_INTEGRATION_CONFIG_BY_CATEGORY,
                        {
                            params: {
                                teamId: teamId,
                                integrationCategory:
                                    IntegrationCategory.CODE_MANAGEMENT,
                            },
                        },
                    ),
                }),
                resetQueries({
                    type: "all",
                    queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                        params: {
                            key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                            teamId,
                        },
                    }),
                }),
                resetQueries({
                    type: "all",
                    queryKey: generateQueryKey(
                        PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                        {
                            params: {
                                teamId,
                            },
                        },
                    ),
                }),
                resetQueries({
                    type: "all",
                    queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                        params: {
                            key: ParametersConfigKey.CENTRALIZED_CONFIG,
                            teamId,
                        },
                    }),
                }),
                revalidateServerSidePath("/settings/git"),
            ]);
        } catch (error) {
            toast({
                variant: "warning",
                title: "Error deleting integration and repositories",
                description: "Please try again later",
            });
        } finally {
            magicModal.hide();
        }
    });

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="w-md">
                <DialogHeader>
                    <DialogTitle>
                        Remove integration with{" "}
                        <strong className="text-danger">{platformName}</strong>?
                    </DialogTitle>
                </DialogHeader>

                <p className="text-sm">
                    You will be able to configure a new Git provider after this
                    operation.
                </p>

                <DialogFooter className="flex flex-col gap-3">
                    <Button
                        size="md"
                        variant="tertiary"
                        loading={!enabled || loadingDeleteAll}
                        onClick={handleDeleteIntegrationAndRepositories}
                        className="w-full">
                        Reset integration and remove repositories config
                    </Button>

                    <div className="flex gap-2">
                        <Button
                            size="md"
                            variant="secondary"
                            loading={!enabled || loading}
                            onClick={handleDelete}
                            className="flex-1">
                            Just reset the integration
                        </Button>

                        <Button
                            size="md"
                            variant="cancel"
                            onClick={() => magicModal.hide()}
                            className="w-[30%]">
                            Cancel
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

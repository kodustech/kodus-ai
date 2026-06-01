"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SelectRepositories } from "@components/system/select-repositories";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { MagicModalContext } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { createOrUpdateRepositoriesInChunks } from "@services/codeManagement/fetch";
import type { Repository } from "@services/codeManagement/types";
import { INTEGRATION_CONFIG } from "@services/integrations/integrationConfig";
import { PARAMETERS_PATHS } from "@services/parameters";
import {
    createOrUpdateCodeReviewParameter,
    getParameterByKey,
    updateCodeReviewParameterRepositories,
} from "@services/parameters/fetch";
import { ParametersConfigKey } from "@services/parameters/types";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { IntegrationCategory } from "src/core/types";

export const SelectRepositoriesModal = (props: {
    platformName: string;
    selectedRepositories: Repository[];
}) => {
    const router = useRouter();
    const { teamId } = useSelectedTeamId();
    const { userId } = useAuth();
    const { invalidateQueries, resetQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();

    const [isLoadingRepositories, setIsLoadingRepositories] = useState(true);
    const [uploadProgress, setUploadProgress] = useState({
        current: 0,
        total: 0,
    });

    const [open, setOpen] = useState(false);
    const [selectedRepositories, setSelectedRepositories] = useState<
        Repository[]
    >(props.selectedRepositories);

    const [
        saveSelectedRepositoriesAction,
        { loading: loadingSaveRepositories },
    ] = useAsyncAction(async () => {
        const result = await createOrUpdateRepositoriesInChunks(
            selectedRepositories,
            teamId,
            (current, total) => setUploadProgress({ current, total }),
        );

        const codeReview: {
            configKey: string;
            configValue: any;
        } = await getParameterByKey(
            ParametersConfigKey.CODE_REVIEW_CONFIG,
            teamId,
        );

        if (!codeReview.configValue) {
            await createOrUpdateCodeReviewParameter({}, teamId, undefined);
        }

        await updateCodeReviewParameterRepositories(teamId);

        if (result.failed > 0) {
            toast({
                variant: "warning",
                title: `${result.success} repositories saved, ${result.failed} failed`,
                description: "Some repositories could not be saved. Try again.",
            });
        } else {
            toast({
                variant: "success",
                title: "Repositories saved",
            });
        }

        await Promise.all([
            resetQueries({
                queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                    params: {
                        key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                        teamId,
                    },
                }),
            }),
            resetQueries({
                queryKey: generateQueryKey(
                    PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                    {
                        params: {
                            teamId,
                        },
                    },
                ),
            }),
            invalidateQueries({
                type: "all",
                queryKey: generateQueryKey(
                    INTEGRATION_CONFIG.GET_INTEGRATION_CONFIG_BY_CATEGORY,
                    {
                        params: {
                            teamId,
                            integrationCategory:
                                IntegrationCategory.CODE_MANAGEMENT,
                        },
                    },
                ),
            }),
        ]);

        setUploadProgress({ current: 0, total: 0 });
        router.push("/settings/git");
        router.refresh();
    });

    const hasChanges = useMemo(() => {
        const initialIds = new Set(props.selectedRepositories.map((r) => r.id));
        if (initialIds.size !== selectedRepositories.length) return true;
        return selectedRepositories.some((r) => !initialIds.has(r.id));
    }, [props.selectedRepositories, selectedRepositories]);

    const closeable =
        props.selectedRepositories.length > 0 &&
        !loadingSaveRepositories &&
        !hasChanges;

    return (
        <MagicModalContext value={{ closeable }}>
            <Dialog
                open
                onOpenChange={() => {
                    router.push("/settings/git");
                }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {props.platformName} repositories setup
                        </DialogTitle>

                        <DialogDescription>
                            Select the repositories you want to use Kody
                        </DialogDescription>
                    </DialogHeader>

                    <FormControl.Root className="w-full">
                        <FormControl.Input>
                            <SelectRepositories
                                open={open}
                                teamId={teamId}
                                onOpenChange={setOpen}
                                selectedRepositories={selectedRepositories}
                                onFinishLoading={() =>
                                    setIsLoadingRepositories(false)
                                }
                                onChangeSelectedRepositories={
                                    setSelectedRepositories
                                }
                            />
                        </FormControl.Input>
                    </FormControl.Root>

                    <DialogFooter>
                        {props.selectedRepositories.length > 0 &&
                            !loadingSaveRepositories && (
                                <Button
                                    size="md"
                                    variant="cancel"
                                    onClick={() =>
                                        router.push("/settings/git")
                                    }>
                                    Cancel
                                </Button>
                            )}

                        <Button
                            size="md"
                            variant="primary"
                            loading={loadingSaveRepositories}
                            onClick={saveSelectedRepositoriesAction}
                            disabled={
                                selectedRepositories.length === 0 ||
                                isLoadingRepositories
                            }>
                            {uploadProgress.total > 0
                                ? `Saving... ${uploadProgress.current}/${uploadProgress.total}`
                                : "Save selected repositories"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </MagicModalContext>
    );
};

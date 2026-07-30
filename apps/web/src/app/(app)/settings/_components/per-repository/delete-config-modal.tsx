import { useState } from "react";
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
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { useTimeout } from "@hooks/use-timeout";
import { PARAMETERS_PATHS } from "@services/parameters";
import {
    deleteRepositoryCodeReviewParameter,
    updateCodeReviewParameterRepositories,
} from "@services/parameters/fetch";
import {
    isCentralizedPrResponse,
    ParametersConfigKey,
} from "@services/parameters/types";
import { TrashIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { generateQueryKey } from "src/core/utils/reactQuery";

import type { CodeReviewRepositoryConfig } from "../../code-review/_types";
import { getCentralizedPrToastPayload } from "../../code-review/_utils/centralized-pr-feedback";

export const DeleteRepoConfigModal = ({
    repository,
    directory,
}: {
    repository: Pick<CodeReviewRepositoryConfig, "id" | "name" | "isSelected">;
    directory?: Pick<
        NonNullable<CodeReviewRepositoryConfig["directories"]>[number],
        "id" | "name" | "folders"
    >;
}) => {
    const { teamId } = useSelectedTeamId();
    const [enabled, setEnabled] = useState(false);
    const { invalidateQueries } = useReactQueryInvalidateQueries();

    useTimeout(() => {
        setEnabled(true);
    }, 5000);

    const [handleSubmit, { loading }] = useAsyncAction(async () => {
        try {
            magicModal.lock();

            const deleteResult = await deleteRepositoryCodeReviewParameter({
                teamId: teamId,
                repositoryId: repository.id,
                directoryId: directory?.id,
            });

            const isCentralizedPr = isCentralizedPrResponse(deleteResult);

            await updateCodeReviewParameterRepositories(teamId);

            await Promise.all([
                invalidateQueries({
                    queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                        params: {
                            key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                            teamId,
                        },
                    }),
                }),
                invalidateQueries({
                    queryKey: generateQueryKey(
                        PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                        {
                            params: {
                                teamId,
                            },
                        },
                    ),
                }),
            ]);

            if (isCentralizedPr) {
                toast(
                    getCentralizedPrToastPayload(
                        deleteResult,
                        "Configuration removal proposed through centralized pull request.",
                    ),
                );
                return;
            }

            toast({
                title: "Configuration removed",
                variant: "success",
            });
        } catch (error: any) {
            console.error("Erro completo:", error);

            const errorMessage =
                error?.response?.data?.message ||
                error?.message ||
                "Não foi possível deletar a configuração do repositório. Tente novamente.";

            toast({
                title: "Error trying to delete configuration",
                description: errorMessage,
                variant: "danger",
            });
        } finally {
            magicModal.hide(true);
        }
    });

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>
                        Delete{" "}
                        <strong className="text-danger">
                            {repository.name}
                            {directory?.folders?.[0]?.path}
                        </strong>{" "}
                        configuration?
                    </DialogTitle>

                    <DialogDescription>
                        This action cannot be undone!{" "}
                        {directory && repository.isSelected
                            ? "After this operation, repository configuration will be applied to this directory."
                            : "After this operation, global configuration will be applied to this repository."}
                    </DialogDescription>
                </DialogHeader>

                <DialogFooter>
                    <DialogClose asChild>
                        <Button size="md" variant="cancel">
                            Cancel
                        </Button>
                    </DialogClose>

                    <Button
                        size="md"
                        variant="tertiary"
                        loading={!enabled || loading}
                        leftIcon={<TrashIcon />}
                        onClick={handleSubmit}>
                        Delete configuration
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

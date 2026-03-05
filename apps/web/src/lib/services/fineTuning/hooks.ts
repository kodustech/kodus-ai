import { useMemo } from "react";
import { useFetch } from "src/core/utils/reactQuery";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { PARAMETERS_PATHS } from "@services/parameters";
import type { FormattedGlobalCodeReviewConfig } from "src/app/(app)/settings/code-review/_types";

export const useFineTuningEnabled = (repositoryId?: string) => {
    const { teamId } = useSelectedTeamId();
    const { data, isLoading } = useFetch<{
        uuid: string;
        configKey: string;
        configValue: FormattedGlobalCodeReviewConfig;
    }>(
        PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
        { params: { teamId } },
        false
    );

    const enabled = useMemo(() => {
        if (isLoading || !data) return true;
        const configValue = data.configValue;
        if (!repositoryId || repositoryId === "global") {
            return configValue.configs?.kodyFineTuningEnabled?.value ?? true;
        }
        const repository = configValue.repositories?.find((r: any) => r.id === repositoryId);
        return repository?.configs?.kodyFineTuningEnabled?.value ?? true;
    }, [data, isLoading, repositoryId]);

    return { enabled, loading: isLoading };
};

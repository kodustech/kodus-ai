"use client";

import { PARAMETERS_PATHS } from "@services/parameters";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import { ParametersConfigKey } from "@services/parameters/types";
import { useQueryClient } from "@tanstack/react-query";
import type { UseFormReturn } from "react-hook-form";
import { unformatConfig } from "src/core/utils/helpers";
import { generateQueryKey } from "src/core/utils/reactQuery";

import {
    CodeReviewFormType,
    type CodeReviewGlobalConfig,
    type FormattedCodeReviewConfig,
    type FormattedGlobalCodeReviewConfig,
} from "../_types";
import { mergeFormattedCodeReviewConfigForScope } from "../_utils/settings-shell";

type SavePreparationResult = {
    savedFormData: CodeReviewFormType;
    codeReviewConfig: Partial<CodeReviewGlobalConfig>;
};

type SaveOptions = {
    prepare?: (
        formData: CodeReviewFormType,
    ) => Promise<SavePreparationResult> | SavePreparationResult;
};

const defaultPrepare = (
    formData: CodeReviewFormType,
): SavePreparationResult => {
    const { language: _language, ...config } = formData;

    return {
        savedFormData: formData,
        codeReviewConfig: unformatConfig(config),
    };
};

export const useCodeReviewSettingsMutation = (params: {
    teamId: string;
    repositoryId: string | undefined;
    directoryId?: string;
    form: UseFormReturn<CodeReviewFormType>;
}) => {
    const queryClient = useQueryClient();
    const { teamId, repositoryId, directoryId, form } = params;

    const syncFormattedConfigSnapshot = (savedFormData: CodeReviewFormType) => {
        const { language: _language, ...formattedConfig } = savedFormData;
        const formattedQueryKey = generateQueryKey(
            PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
            {
                params: { teamId },
            },
        );

        queryClient.setQueryData<{
            uuid: string;
            configKey: ParametersConfigKey.CODE_REVIEW_CONFIG;
            configValue: FormattedGlobalCodeReviewConfig;
        }>(formattedQueryKey, (current) => {
            if (!current) return current;

            return {
                ...current,
                configValue: mergeFormattedCodeReviewConfigForScope(
                    current.configValue,
                    {
                        repositoryId: repositoryId ?? "global",
                        directoryId,
                    },
                    formattedConfig as FormattedCodeReviewConfig,
                )!,
            };
        });
    };

    const invalidateRelatedQueries = () => {
        void queryClient.invalidateQueries({
            queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                params: {
                    key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                    teamId,
                },
            }),
            refetchType: "inactive",
        });
        void queryClient.invalidateQueries({
            queryKey: generateQueryKey(
                PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                {
                    params: { teamId },
                },
            ),
            refetchType: "inactive",
        });
    };

    const saveSettings = async (
        formData: CodeReviewFormType,
        options?: SaveOptions,
    ) => {
        const prepared = await (options?.prepare ?? defaultPrepare)(formData);

        const result = await createOrUpdateCodeReviewParameter(
            prepared.codeReviewConfig,
            teamId,
            repositoryId,
            directoryId,
        );

        if (result.error) {
            throw new Error(`Failed to save settings: ${result.error}`);
        }

        syncFormattedConfigSnapshot(prepared.savedFormData);
        form.reset(prepared.savedFormData);
        invalidateRelatedQueries();
    };

    return { saveSettings };
};

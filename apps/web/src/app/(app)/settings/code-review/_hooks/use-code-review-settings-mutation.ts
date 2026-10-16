"use client";

import { PARAMETERS_PATHS } from "@services/parameters";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import {
    isCentralizedPrResponse,
    ParametersConfigKey,
    type CentralizedPrResponse,
} from "@services/parameters/types";
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
import {
    getChangedConfigMask,
    pickChangedConfig,
} from "../_utils/changed-config";
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

type SaveSettingsResult = {
    centralizedPr?: CentralizedPrResponse;
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
        queryClient.invalidateQueries({
            queryKey: generateQueryKey(PARAMETERS_PATHS.CODE_REVIEW_SCOPES, {
                params: { teamId },
            }),
        });
        // Use "all" instead of "inactive" so the active query refetches
        // from the backend after save. The backend's formatLevel() computes
        // overriddenValue/overriddenLevel correctly — the optimistic cache
        // update from syncFormattedConfigSnapshot lacks those fields,
        // causing override indicators to show incorrect markers until the
        // page is manually reloaded.
        void queryClient.invalidateQueries({
            queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                params: {
                    key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                    teamId,
                },
            }),
            refetchType: "all",
        });
        void queryClient.invalidateQueries({
            queryKey: generateQueryKey(
                PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                {
                    params: { teamId },
                },
            ),
            refetchType: "all",
        });
        void queryClient.invalidateQueries({
            queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                params: {
                    key: ParametersConfigKey.LANGUAGE_CONFIG,
                    teamId,
                },
            }),
            refetchType: "all",
        });
    };

    const saveSettings = async (
        formData: CodeReviewFormType,
        options?: SaveOptions,
    ): Promise<SaveSettingsResult> => {
        const prepared = await (options?.prepare ?? defaultPrepare)(formData);

        const { language: _language, ...formattedConfig } = formData;
        // `formState.defaultValues` is the snapshot of the last render and
        // lags behind a reset; the control holds the live defaults.
        const changedConfig = pickChangedConfig(
            prepared.codeReviewConfig,
            getChangedConfigMask(formattedConfig, form.control._defaultValues),
        );

        // Nothing in the code-review config changed (e.g. only the language,
        // which `prepare` already saved).
        if (Object.keys(changedConfig).length === 0) {
            form.reset(prepared.savedFormData);
            invalidateRelatedQueries();
            return {};
        }

        const result = await createOrUpdateCodeReviewParameter(
            changedConfig,
            teamId,
            repositoryId,
            directoryId,
        );

        if ((result as { error?: string })?.error) {
            throw new Error(
                `Failed to save settings: ${(result as { error: string }).error}`,
            );
        }

        if (isCentralizedPrResponse(result)) {
            form.reset(prepared.savedFormData);
            invalidateRelatedQueries();
            return { centralizedPr: result };
        }

        form.reset(prepared.savedFormData);
        invalidateRelatedQueries();

        return {};
    };

    return { saveSettings };
};

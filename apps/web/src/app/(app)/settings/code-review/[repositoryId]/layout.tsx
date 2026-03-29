"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useOptionalParameterQuery } from "@services/parameters/hooks";
import {
    LanguageValue,
    ParametersConfigKey,
    type CentralizedConfigValue,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { FormProvider, useForm } from "react-hook-form";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { type CodeReviewFormType } from "../_types";
import {
    buildCodeReviewSettingsHydrationKey,
    buildCodeReviewSettingsScopeKey,
    shouldHydrateCodeReviewForm,
} from "../_utils/settings-shell";
import {
    useCodeReviewConfig,
    useDefaultCodeReviewConfig,
    useFeatureFlags,
} from "../../_components/context";
import { useCodeReviewRouteParams } from "../../_hooks";
import { normalizePromptFormValues } from "./custom-prompts/_utils/custom-prompts-state";

export default function Layout(props: React.PropsWithChildren) {
    const { teamId } = useSelectedTeamId();
    const config = useCodeReviewConfig();
    const defaultCodeReviewConfig = useDefaultCodeReviewConfig();
    const { directoryId, pageName } = useCodeReviewRouteParams();
    const parameters = useOptionalParameterQuery<LanguageValue>(
        ParametersConfigKey.LANGUAGE_CONFIG,
        teamId,
        {
            uuid: "",
            configKey: ParametersConfigKey.LANGUAGE_CONFIG,
            configValue: LanguageValue.ENGLISH,
        },
    );

    const { data: centralizedConfig, isLoading: isCentralizedConfigLoading } =
        useOptionalParameterQuery<CentralizedConfigValue>(
            ParametersConfigKey.CENTRALIZED_CONFIG,
            teamId,
            {
                uuid: "",
                configKey: ParametersConfigKey.CENTRALIZED_CONFIG,
                configValue: {
                    enabled: false,
                    repository: {
                        id: "",
                        name: "",
                    },
                },
            },
        );

    const params = useParams();
    const repositoryId = params.repositoryId as string;
    const scopeKey = buildCodeReviewSettingsScopeKey(
        teamId,
        repositoryId,
        directoryId,
    );
    const language = parameters.data?.configValue ?? LanguageValue.ENGLISH;
    const initialFormValues = useMemo(
        () =>
            normalizePromptFormValues(
                {
                    ...config,
                    language,
                },
                defaultCodeReviewConfig?.v2PromptOverrides,
            ),
        [config, defaultCodeReviewConfig?.v2PromptOverrides, language],
    );
    const hydrationKey = useMemo(
        () => buildCodeReviewSettingsHydrationKey(scopeKey, language),
        [language, scopeKey],
    );
    const hydratedStateKeyRef = useRef(hydrationKey);

    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
    const { centralizedConfigParameter } = useFeatureFlags();

    const isCodeReviewParameterPage = new Set([
        "general",
        "review-categories",
        "custom-prompts",
        "suggestion-control",
        "pr-summary",
    ]).has(pageName);

    const isCentralizedConfigEnabled =
        centralizedConfigParameter === true &&
        (isCentralizedConfigLoading ||
            centralizedConfig?.configValue?.enabled === true);

    const canEditWithCentralizedConfig =
        canEdit && (!isCentralizedConfigEnabled || !isCodeReviewParameterPage);

    const form = useForm<CodeReviewFormType>({
        mode: "all",
        criteriaMode: "firstError",
        reValidateMode: "onChange",
        defaultValues: initialFormValues,
        disabled: !canEditWithCentralizedConfig,
    });
    const {
        isDirty: formIsDirty,
        isSubmitting: formIsSubmitting,
        dirtyFields,
    } = form.formState;

    useEffect(() => {
        if (
            !shouldHydrateCodeReviewForm(
                hydratedStateKeyRef.current,
                hydrationKey,
            )
        ) {
            return;
        }

        form.reset(initialFormValues);
        hydratedStateKeyRef.current = hydrationKey;
    }, [form, hydrationKey, initialFormValues]);

    const sharedFormIsDirty = useCallback(() => {
        const check = (
            value: Record<string, unknown>,
            excludeKeys?: string[],
        ): boolean => {
            for (const key of Object.keys(value)) {
                if (excludeKeys?.includes(key)) {
                    continue;
                }

                const fieldValue = value[key];
                if (
                    typeof fieldValue === "object" &&
                    fieldValue !== null &&
                    !Array.isArray(fieldValue)
                ) {
                    if (check(fieldValue as Record<string, unknown>)) {
                        return true;
                    }
                    continue;
                }

                if (fieldValue === true) {
                    return true;
                }
            }

            return false;
        };

        return check(dirtyFields as Record<string, unknown>, [
            "v2PromptOverrides",
        ]);
    }, [dirtyFields]);

    const scrollToDirtyField = useCallback(() => {
        const findFirstDirtyKey = (
            value: Record<string, unknown>,
            prefix = "",
            excludeKeys?: string[],
        ): string | null => {
            for (const key of Object.keys(value)) {
                if (excludeKeys?.includes(key)) {
                    continue;
                }

                const path = prefix ? `${prefix}.${key}` : key;
                const fieldValue = value[key];

                if (
                    typeof fieldValue === "object" &&
                    fieldValue !== null &&
                    !Array.isArray(fieldValue)
                ) {
                    const found = findFirstDirtyKey(
                        fieldValue as Record<string, unknown>,
                        path,
                    );
                    if (found) {
                        return found;
                    }
                    continue;
                }

                if (fieldValue === true) {
                    return path;
                }
            }

            return null;
        };

        const dirtyKey = findFirstDirtyKey(
            dirtyFields as Record<string, unknown>,
            "",
            ["v2PromptOverrides"],
        );

        if (dirtyKey) {
            let fieldElement: Element | null = null;
            const segments = dirtyKey.split(".");

            for (
                let index = segments.length;
                index > 0 && !fieldElement;
                index--
            ) {
                const prefix = segments.slice(0, index).join(".");
                fieldElement = document.querySelector(
                    `[data-field-name="${prefix}"]`,
                );
            }

            if (fieldElement) {
                fieldElement.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                });
                fieldElement.classList.add("field-highlight");
                window.setTimeout(() => {
                    fieldElement?.classList.remove("field-highlight");
                }, 1800);

                fieldElement
                    .querySelectorAll<HTMLElement>(
                        "[data-reset-button]:not(:disabled)",
                    )
                    .forEach((button) => {
                        button.classList.add("field-highlight");
                        window.setTimeout(() => {
                            button.classList.remove("field-highlight");
                        }, 1800);
                    });

                return;
            }
        }

        const headerElement = document.querySelector("[data-header-actions]");
        if (headerElement) {
            headerElement.scrollIntoView({
                behavior: "smooth",
                block: "center",
            });
            headerElement.classList.add("field-highlight");
            window.setTimeout(() => {
                headerElement.classList.remove("field-highlight");
            }, 1800);
            return;
        }

        window.scrollTo({ top: 0, behavior: "smooth" });
    }, [dirtyFields]);

    useUnsavedChangesGuard({
        id: "code-review-settings",
        isDirty: sharedFormIsDirty() || formIsSubmitting || formIsDirty,
        onBlock: scrollToDirtyField,
    });

    return <FormProvider {...form}>{props.children}</FormProvider>;
}

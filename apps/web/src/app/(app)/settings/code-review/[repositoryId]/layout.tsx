"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useOptionalParameterQuery } from "@services/parameters/hooks";
import { LanguageValue, ParametersConfigKey } from "@services/parameters/types";
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
    findFirstDirtyFieldOutsidePromptOverrides,
    shouldBlockCodeReviewLayoutNavigation,
} from "./_utils/layout-dirty-state";
import {
    useCodeReviewConfig,
    useDefaultCodeReviewConfig,
} from "../../_components/context";
import { useCodeReviewRouteParams } from "../../_hooks";
import { normalizePromptFormValues } from "./custom-prompts/_utils/custom-prompts-state";

export default function Layout(props: React.PropsWithChildren) {
    const { teamId } = useSelectedTeamId();
    const config = useCodeReviewConfig();
    const defaultCodeReviewConfig = useDefaultCodeReviewConfig();
    const { directoryId } = useCodeReviewRouteParams();
    const parameters = useOptionalParameterQuery<LanguageValue>(
        ParametersConfigKey.LANGUAGE_CONFIG,
        teamId,
        {
            uuid: "",
            configKey: ParametersConfigKey.LANGUAGE_CONFIG,
            configValue: LanguageValue.ENGLISH,
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

    const form = useForm<CodeReviewFormType>({
        mode: "all",
        criteriaMode: "firstError",
        reValidateMode: "onChange",
        defaultValues: initialFormValues,
        disabled: !canEdit,
    });
    const {
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

    const scrollToDirtyField = useCallback(() => {
        const dirtyKey = findFirstDirtyFieldOutsidePromptOverrides(
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
        isDirty: shouldBlockCodeReviewLayoutNavigation({
            dirtyFields: dirtyFields as Record<string, unknown>,
            formIsSubmitting,
        }),
        onBlock: scrollToDirtyField,
    });

    return <FormProvider {...form}>{props.children}</FormProvider>;
}

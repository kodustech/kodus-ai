"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    useCodeReviewConfig,
    useDefaultCodeReviewConfig,
    useInitialParameter,
    useInitialTeamId,
} from "../../_components/context";
import { useCodeReviewRouteParams } from "../../_hooks";
import {
    findFirstDirtyFieldOutsidePromptOverrides,
    shouldBlockCodeReviewLayoutNavigation,
} from "./_utils/layout-dirty-state";
import { withModelOverrideField } from "./_utils/model-override-field";
import { normalizePromptFormValues } from "./custom-prompts/_utils/custom-prompts-state";

export default function Layout(props: React.PropsWithChildren) {
    const { teamId } = useSelectedTeamId();
    const config = useCodeReviewConfig();
    const defaultCodeReviewConfig = useDefaultCodeReviewConfig();
    const bridgeInitialTeamId = useInitialTeamId();
    const initialLanguage = useInitialParameter(
        ParametersConfigKey.LANGUAGE_CONFIG,
    );
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
    const language =
        parameters.data?.configValue ??
        (teamId === bridgeInitialTeamId
            ? (initialLanguage?.configValue as LanguageValue)
            : undefined) ??
        LanguageValue.ENGLISH;
    const initialFormValues = useMemo(
        () =>
            withModelOverrideField(
                normalizePromptFormValues(
                    {
                        ...config,
                        language,
                    },
                    defaultCodeReviewConfig?.v2PromptOverrides,
                ),
            ),
        [config, defaultCodeReviewConfig?.v2PromptOverrides, language],
    );
    const hydrationKey = useMemo(
        () => buildCodeReviewSettingsHydrationKey(scopeKey, language),
        [language, scopeKey],
    );
    const hydratedStateKeyRef = useRef(hydrationKey);
    const appliedFormValuesRef = useRef(initialFormValues);

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
    // Dirty fields come from a subscription, not from this render: undoing
    // a change (a switch flipped on, then off) does not re-render the
    // layout, so a value captured at render kept navigation blocked on a
    // clean form, with Reset and Save disabled.
    const formIsSubmitting = form.formState.isSubmitting;
    const dirtyFieldsRef = useRef<Record<string, unknown>>({});
    const [hasDirtyFields, setHasDirtyFields] = useState(false);
    useEffect(
        () =>
            form.subscribe({
                formState: { dirtyFields: true },
                callback: ({ dirtyFields }) => {
                    dirtyFieldsRef.current = (dirtyFields ?? {}) as Record<
                        string,
                        unknown
                    >;
                    setHasDirtyFields(
                        shouldBlockCodeReviewLayoutNavigation({
                            dirtyFields: dirtyFieldsRef.current,
                            formIsSubmitting: false,
                        }),
                    );
                },
            }),
        [form],
    );

    useEffect(() => {
        if (
            !shouldHydrateCodeReviewForm(
                hydratedStateKeyRef.current,
                hydrationKey,
            )
        ) {
            if (appliedFormValuesRef.current === initialFormValues) return;

            // Same scope, refetched config (e.g. a Kody Rules toggle saved on
            // its own): take the server values for every field the user has
            // not edited, so the form never holds a value that is gone. The
            // other flags keep pending edits flagged as unsaved.
            form.reset(initialFormValues, {
                keepDirtyValues: true,
                keepDirty: true,
                keepErrors: true,
                keepTouched: true,
            });
            appliedFormValuesRef.current = initialFormValues;
            return;
        }

        form.reset(initialFormValues);
        hydratedStateKeyRef.current = hydrationKey;
        appliedFormValuesRef.current = initialFormValues;
    }, [form, hydrationKey, initialFormValues]);

    const scrollToDirtyField = useCallback(() => {
        const dirtyKey = findFirstDirtyFieldOutsidePromptOverrides(
            dirtyFieldsRef.current,
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
    }, []);

    useUnsavedChangesGuard({
        id: "code-review-settings",
        isDirty: hasDirtyFields || formIsSubmitting,
        onBlock: scrollToDirtyField,
    });

    return <FormProvider {...form}>{props.children}</FormProvider>;
}

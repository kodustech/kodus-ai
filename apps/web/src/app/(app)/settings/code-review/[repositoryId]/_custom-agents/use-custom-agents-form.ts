"use client";

import { useCallback } from "react";
import {
    prepareAgentsForSave,
    prepareKnowledgeForSave,
} from "@services/custom-agents/drafts";
import type { CustomAgent, KnowledgeItem } from "@services/custom-agents/types";
import { useFormContext, useFormState, useWatch } from "react-hook-form";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import type { CodeReviewFormType } from "../../_types";
import {
    loadedListRevision,
    type RevisionedListField,
} from "../../_utils/settings-save-conflict";
import {
    useCodeReviewRouteParams,
    useCurrentConfigLevel,
} from "../../../_hooks";

/**
 * A list as the form holds it. `revision` is set on the first edit to the
 * revision of the list the edit started from, and travels with the draft
 * (see settings-save-conflict.ts).
 */
type FieldNode<T> =
    { value?: T; level?: string; revision?: string } | undefined;

/**
 * The custom agents and the skills and docs they link, read from and written
 * to the code review form. Both are whole arrays at the current level, like
 * every other list in the cascade.
 */
export const useCustomAgentsForm = () => {
    const form = useFormContext<CodeReviewFormType>();
    const level = useCurrentConfigLevel();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { saveSettings } = useCodeReviewSettingsMutation({
        teamId,
        repositoryId,
        directoryId,
        form,
    });

    const agentsNode = useWatch({
        control: form.control,
        name: "customAgents" as never,
    }) as FieldNode<CustomAgent[]>;
    const knowledgeNode = useWatch({
        control: form.control,
        name: "knowledge" as never,
    }) as FieldNode<KnowledgeItem[]>;
    const { dirtyFields, isSubmitting } = useFormState({
        control: form.control,
    });

    const agents = agentsNode?.value ?? [];
    const knowledge = knowledgeNode?.value ?? [];
    const dirtyKeys = Object.keys(dirtyFields ?? {});
    const isDirty = dirtyKeys.some(
        (key) => key === "customAgents" || key === "knowledge",
    );
    const otherFieldsDirty = dirtyKeys.some(
        (key) => key !== "customAgents" && key !== "knowledge",
    );

    const setList = useCallback(
        (field: RevisionedListField, next: unknown[]) =>
            form.setValue(
                field as never,
                {
                    value: next,
                    level,
                    revision: loadedListRevision(form.getValues(), field),
                } as never,
                { shouldDirty: true },
            ),
        [form, level],
    );
    const setAgents = useCallback(
        (next: CustomAgent[]) => setList("customAgents", next),
        [setList],
    );
    const setKnowledge = useCallback(
        (next: KnowledgeItem[]) => setList("knowledge", next),
        [setList],
    );
    const updateAgent = useCallback(
        (id: string, patch: (agent: CustomAgent) => CustomAgent) => {
            const current =
                (
                    form.getValues("customAgents" as never) as FieldNode<
                        CustomAgent[]
                    >
                )?.value ?? [];
            setAgents(
                current.map((agent) =>
                    agent.id === id ? patch(agent) : agent,
                ),
            );
        },
        [form, setAgents],
    );

    /**
     * Saves only the agents and knowledge on screen. The save names the
     * revision each list was loaded at: if someone else changed a list
     * since, it is refused and the form keeps the edits.
     */
    const save = useCallback(
        (next?: { agents?: CustomAgent[]; knowledge?: KnowledgeItem[] }) => {
            if (next?.agents) setAgents(next.agents);
            if (next?.knowledge) setKnowledge(next.knowledge);
            const formData = form.getValues();
            const values = formData as unknown as {
                customAgents?: FieldNode<CustomAgent[]>;
                knowledge?: FieldNode<KnowledgeItem[]>;
            };
            return saveSettings(formData, {
                prepare: (data) => ({
                    savedFormData: data,
                    codeReviewConfig: {
                        customAgents: prepareAgentsForSave(
                            values.customAgents?.value ?? [],
                        ),
                        knowledge: prepareKnowledgeForSave(
                            values.knowledge?.value ?? [],
                        ),
                    },
                }),
            });
        },
        [form, saveSettings, setAgents, setKnowledge],
    );

    // Not `resetField`: it acts only on registered fields, and these two are
    // written with `setValue`, so the edit stayed; and a field-level reset
    // does not re-render the settings layout, whose leave guard then kept the
    // user on the page. A form reset that puts back only these two saved
    // values, keeps every other field as it is and recomputes dirtiness
    // against the saved config reaches every subscriber.
    const reset = useCallback(() => {
        // The control holds the live defaults: `formState.defaultValues` is
        // the last render's snapshot and still held the page-load agents
        // after a save, so Reset brought back the version before it.
        const saved = (form.control._defaultValues ??
            {}) as Partial<CodeReviewFormType>;
        form.reset(
            {
                ...form.getValues(),
                customAgents: saved.customAgents,
                knowledge: saved.knowledge,
            } as CodeReviewFormType,
            {
                keepDefaultValues: true,
                keepErrors: true,
                keepTouched: true,
                keepIsValid: true,
                keepSubmitCount: true,
                keepIsSubmitted: true,
            },
        );
    }, [form]);

    return {
        teamId,
        repositoryId,
        directoryId,
        agents,
        knowledge,
        level,
        isDirty,
        otherFieldsDirty,
        isSubmitting,
        setAgents,
        setKnowledge,
        updateAgent,
        save,
        reset,
    };
};

export const agentPageHref = (
    repositoryId: string,
    agentId: string,
    directoryId?: string,
) =>
    `/settings/code-review/${repositoryId}/agents/${encodeURIComponent(agentId)}${
        directoryId ? `?directoryId=${directoryId}` : ""
    }`;

export const skillsPageHref = (repositoryId: string, directoryId?: string) =>
    `/settings/code-review/${repositoryId}/skills${
        directoryId ? `?directoryId=${directoryId}` : ""
    }`;

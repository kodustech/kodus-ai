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
    useCodeReviewRouteParams,
    useCurrentConfigLevel,
} from "../../../_hooks";

type FieldNode<T> = { value?: T; level?: string } | undefined;

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

    const setAgents = useCallback(
        (next: CustomAgent[]) =>
            form.setValue(
                "customAgents" as never,
                { value: next, level } as never,
                { shouldDirty: true },
            ),
        [form, level],
    );
    const setKnowledge = useCallback(
        (next: KnowledgeItem[]) =>
            form.setValue(
                "knowledge" as never,
                { value: next, level } as never,
                { shouldDirty: true },
            ),
        [form, level],
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

    /** Saves only the agents and knowledge on screen. */
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

    const reset = useCallback(() => {
        form.resetField("customAgents" as never);
        form.resetField("knowledge" as never);
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

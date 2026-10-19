"use client";

import Link from "next/link";
import { Input } from "@components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import TagInput from "@components/ui/tag-input";
import { Textarea } from "@components/ui/textarea";
import {
    CUSTOM_AGENT_LIMITS,
    nameCollisionHint,
    TAG_COLORS,
} from "@services/custom-agents/drafts";
import type {
    CustomAgent,
    CustomAgentPresentation,
    CustomAgentResolveReport,
    CustomAgentSeverity,
    KnowledgeItem,
} from "@services/custom-agents/types";
import { getBYOK } from "@services/organizationParameters/fetch";
import { useQuery } from "@tanstack/react-query";
import { cn } from "src/core/utils/components";
import { formatModelLabel } from "src/features/ee/byok/_data/model-label";
import type { BYOKConfig } from "src/features/ee/byok/_types";

import { Choice, Field, Section } from "./field";
import { AgentKnowledgeField } from "./knowledge-card";

type Patch = (patch: (agent: CustomAgent) => CustomAgent) => void;

export const InstructionsCard = ({
    agent,
    canEdit,
    onChange,
    nameError,
}: {
    agent: CustomAgent;
    canEdit: boolean;
    onChange: Patch;
    /** Why the name can't be saved (another agent has its command name). */
    nameError?: string | null;
}) => (
    <Section
        title="Instructions"
        description="A brief to a reviewer who knows the codebase: what to look for, what to ignore, what proof a finding needs.">
        <Field
            label="Name"
            htmlFor="agent-name"
            hint={nameCollisionHint(agent.name) ?? undefined}
            error={nameError ?? undefined}>
            <Input
                id="agent-name"
                size="md"
                value={agent.name}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? "agent-name-error" : undefined}
                disabled={!canEdit}
                maxLength={60}
                onChange={(e) =>
                    onChange((current) => ({
                        ...current,
                        name: e.target.value,
                    }))
                }
            />
        </Field>
        <Field
            label="Instructions"
            htmlFor="agent-instructions"
            hint={`${agent.instructions.length} / ${CUSTOM_AGENT_LIMITS.maxInstructionsLength}`}>
            <Textarea
                id="agent-instructions"
                className="min-h-40 font-mono text-xs"
                value={agent.instructions}
                disabled={!canEdit}
                maxLength={CUSTOM_AGENT_LIMITS.maxInstructionsLength}
                onChange={(e) =>
                    onChange((current) => ({
                        ...current,
                        instructions: e.target.value,
                    }))
                }
            />
        </Field>
    </Section>
);

/** Globs holding `(` or `[`, which are glob syntax as well as path text. */
const globsWithBrackets = (agent: CustomAgent) =>
    [...(agent.scope.include ?? []), ...(agent.scope.exclude ?? [])].filter(
        (glob) => /[([]/.test(glob),
    );

export const FilesAndKnowledge = ({
    agent,
    knowledge,
    report,
    canEdit,
    onChange,
    onKnowledgeChange,
    skillsHref,
}: {
    agent: CustomAgent;
    knowledge: KnowledgeItem[];
    report?: CustomAgentResolveReport;
    canEdit: boolean;
    onChange: Patch;
    onKnowledgeChange: (next: KnowledgeItem[]) => void;
    skillsHref: string;
}) => {
    const bracketed = globsWithBrackets(agent);
    return (
        <Section
            title="Files & knowledge"
            description="The agent runs when a pull request changes a matching file, and reads the skills and docs it follows.">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field
                    label="Files"
                    htmlFor="agent-include"
                    hint="e.g. src/payments/**. Empty runs on every pull request.">
                    <TagInput
                        id="agent-include"
                        tags={agent.scope.include ?? []}
                        disabled={!canEdit}
                        placeholder="Add a glob and press Enter"
                        onTagsChange={(include) =>
                            onChange((current) => ({
                                ...current,
                                scope: { ...current.scope, include },
                            }))
                        }
                    />
                </Field>
                <Field
                    label="Except"
                    htmlFor="agent-exclude"
                    hint="e.g. **/*.test.ts, **/generated/**">
                    <TagInput
                        id="agent-exclude"
                        tags={agent.scope.exclude ?? []}
                        disabled={!canEdit}
                        placeholder="Add a glob and press Enter"
                        onTagsChange={(exclude) =>
                            onChange((current) => ({
                                ...current,
                                scope: { ...current.scope, exclude },
                            }))
                        }
                    />
                </Field>
            </div>
            {bracketed.length > 0 && (
                <p role="note" className="text-text-secondary text-xs">
                    {bracketed.join(", ")}: parentheses and brackets are glob
                    syntax, so these also match as literal path text, as in
                    Next.js route folders like (shop) or [id].
                </p>
            )}
            <div className="flex flex-col gap-1.5">
                <span className="text-text-primary text-xs font-medium">
                    Skills &amp; docs
                </span>
                <span className="text-text-tertiary text-xs">
                    Read from the target branch: a skill opens when the change
                    needs it, a doc loads whole.{" "}
                    <Link
                        href={skillsHref}
                        className="text-primary-light hover:underline">
                        Manage skills &amp; docs
                    </Link>
                </span>
                <AgentKnowledgeField
                    agentId={agent.id}
                    knowledge={knowledge}
                    report={report}
                    canEdit={canEdit}
                    onChange={onKnowledgeChange}
                />
            </div>
        </Section>
    );
};

const SEVERITIES: Array<{ value: CustomAgentSeverity | "any"; label: string }> =
    [
        // Unset follows the team's "Minimum severity to post", as the
        // review applies it; "Low" is the way to post everything.
        { value: "any", label: "Team minimum" },
        { value: "low", label: "Low (everything)" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "critical", label: "Critical" },
    ];

/** The tag colors an agent's comments can carry. */
export const TagColorPicker = ({
    value,
    disabled,
    onChange,
}: {
    value: string;
    disabled?: boolean;
    onChange: (color: string) => void;
}) => (
    <div className="flex gap-1.5">
        {TAG_COLORS.map((color) => (
            <button
                key={color}
                type="button"
                aria-label={`Tag color ${color}`}
                aria-pressed={value === color}
                disabled={disabled}
                onClick={() => onChange(color)}
                className={cn(
                    "size-5 rounded-full ring-offset-2 transition",
                    value === color && "ring-text-primary ring-2",
                )}
                style={{ backgroundColor: color }}
            />
        ))}
    </div>
);

export const CommentsAndModel = ({
    agent,
    canEdit,
    onChange,
}: {
    agent: CustomAgent;
    canEdit: boolean;
    onChange: Patch;
}) => {
    const set = (patch: Partial<CustomAgentPresentation>) =>
        onChange((current) => ({
            ...current,
            presentation: { ...current.presentation, ...patch },
        }));
    const presentation = agent.presentation;

    return (
        <Section
            title="Comments & model"
            description="Comments carry the agent's tag, so the team knows who is speaking.">
            <Field label="Tag">
                <div className="flex items-center gap-3">
                    <span
                        className="inline-flex h-6 items-center rounded px-2 text-xs font-medium text-white"
                        style={{ backgroundColor: presentation.tag.color }}>
                        {agent.name || "Agent"}
                    </span>
                    <TagColorPicker
                        value={presentation.tag.color}
                        disabled={!canEdit}
                        onChange={(color) => set({ tag: { color } })}
                    />
                </div>
            </Field>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field
                    label="Format"
                    hint={
                        presentation.format === "inline"
                            ? "A comment on each line the agent flags."
                            : "All the agent's findings in one comment on the pull request."
                    }>
                    <Choice
                        value={presentation.format}
                        disabled={!canEdit}
                        onChange={(format) => set({ format })}
                        options={[
                            { value: "inline", label: "Inline comments" },
                            {
                                value: "single-comment",
                                label: "One PR comment",
                            },
                        ]}
                    />
                </Field>
                <Field
                    label="Minimum severity"
                    hint="Findings below it are not posted. Team minimum follows What to review.">
                    <Select
                        value={presentation.minSeverity ?? "any"}
                        disabled={!canEdit}
                        onValueChange={(value) =>
                            set({
                                minSeverity:
                                    value === "any"
                                        ? undefined
                                        : (value as CustomAgentSeverity),
                            })
                        }>
                        <SelectTrigger size="md">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SEVERITIES.map((severity) => (
                                <SelectItem
                                    key={severity.value}
                                    value={severity.value}>
                                    {severity.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
                <Field
                    label="Max comments per pull request"
                    htmlFor="agent-max-comments"
                    hint="Posts the most severe ones. Empty for no limit.">
                    <Input
                        id="agent-max-comments"
                        size="md"
                        type="number"
                        min={1}
                        disabled={!canEdit}
                        value={presentation.maxComments ?? ""}
                        onChange={(e) => {
                            const value = Number.parseInt(e.target.value, 10);
                            set({
                                maxComments:
                                    Number.isFinite(value) && value > 0
                                        ? value
                                        : undefined,
                            });
                        }}
                    />
                </Field>
                <Field
                    label="Suggested fix"
                    hint="Code the comment proposes, when the agent is sure of the change. Never: it only describes the problem.">
                    <Choice
                        value={presentation.suggestedFix}
                        disabled={!canEdit}
                        onChange={(suggestedFix) => set({ suggestedFix })}
                        options={[
                            {
                                value: "when-confident",
                                label: "When confident",
                            },
                            { value: "never", label: "Never" },
                        ]}
                    />
                </Field>
            </div>

            <Field
                label="How it writes"
                htmlFor="agent-writing"
                hint="Tone, length and what every comment must say. Comments are in the language set in General. Empty: the team's writing settings.">
                <Textarea
                    id="agent-writing"
                    className="min-h-20 text-sm"
                    value={presentation.writing ?? ""}
                    disabled={!canEdit}
                    maxLength={CUSTOM_AGENT_LIMITS.maxWritingLength}
                    onChange={(e) =>
                        set({ writing: e.target.value || undefined })
                    }
                />
            </Field>
            <ModelsFields agent={agent} canEdit={canEdit} onChange={onChange} />
        </Section>
    );
};

const ROUTING_DEFAULT = "__routing";

/** The organization's BYOK models, shared by every model picker and label. */
export const useByokModels = () => {
    const byok = useQuery({
        queryKey: ["custom-agents-byok-models"],
        queryFn: async () => ((await getBYOK()) ?? null) as BYOKConfig | null,
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
    const models = byok.data?.models ?? [];
    return {
        models,
        routing: byok.data?.routing,
        isLoading: byok.isLoading,
        /** A model's readable name, never its raw id. */
        nameOf: (id?: string) => {
            const model = models.find((entry) => entry.id === id)?.model;
            return model ? formatModelLabel(model) : undefined;
        },
    };
};

/** The model picker, without a card around it. */
export const ModelsFields = ({
    agent,
    canEdit,
    onChange,
}: {
    agent: CustomAgent;
    canEdit: boolean;
    onChange: Patch;
}) => {
    const byok = useByokModels();
    const { models, routing, nameOf: labelOf } = byok;
    const routed = labelOf(
        routing?.taskOverrides?.customAgent ?? routing?.defaultModelId,
    );

    const pick = (value: string) =>
        onChange((current) => ({
            ...current,
            models: value === ROUTING_DEFAULT ? undefined : { run: value },
        }));

    const selector = (
        <Select
            value={agent.models?.run ?? ROUTING_DEFAULT}
            disabled={!canEdit || !models.length}
            onValueChange={pick}>
            <SelectTrigger size="md" aria-label="Model">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value={ROUTING_DEFAULT}>
                    Routing default
                    {routed ? ` (${routed})` : ""}
                </SelectItem>
                {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                        {formatModelLabel(model.model)}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );

    return (
        <>
            {!byok.isLoading && !models.length && (
                <p className="text-text-secondary text-xs">
                    No BYOK models configured: the agent uses Kodus&apos;s
                    models.
                </p>
            )}
            <Field
                label="Model"
                hint="Reviews the change and verifies its findings. The default follows the routing table.">
                {selector}
            </Field>
        </>
    );
};

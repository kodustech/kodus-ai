"use client";

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
import type { BYOKConfig } from "src/features/ee/byok/_types";

import { Chip, Choice, Field, Section } from "./field";

type Patch = (patch: (agent: CustomAgent) => CustomAgent) => void;

export const WhatItDoes = ({
    agent,
    knowledge,
    report,
    canEdit,
    onChange,
    nameError,
}: {
    agent: CustomAgent;
    knowledge: KnowledgeItem[];
    report?: CustomAgentResolveReport;
    canEdit: boolean;
    onChange: Patch;
    /** Why the name can't be saved (another agent has its command name). */
    nameError?: string | null;
}) => {
    const linked = knowledge.filter((item) =>
        item.linkedTo.some(
            (target) =>
                typeof target === "object" && target.agentId === agent.id,
        ),
    );
    const skills = linked.filter((item) => item.kind === "skill").length;
    const docs = linked.filter((item) => item.kind === "doc").length;
    const plugins = agent.tools.mcp?.length ?? 0;
    const clis = agent.tools.cli?.length ?? 0;
    const rules = report?.astGrep.ruleCount ?? 0;

    return (
        <Section
            title="What this agent does"
            description="Write it like a brief to a reviewer who knows the codebase: what to look for, what to ignore, and what proof a finding needs.">
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
                    aria-describedby={
                        nameError ? "agent-name-error" : undefined
                    }
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
            <div className="flex flex-wrap gap-1.5">
                <Chip>
                    {skills} {skills === 1 ? "skill" : "skills"}
                </Chip>
                <Chip>
                    {docs} {docs === 1 ? "doc" : "docs"}
                </Chip>
                {agent.tools.astGrepConfig?.trim() && (
                    <Chip>
                        ast-grep · {rules} {rules === 1 ? "rule" : "rules"}
                    </Chip>
                )}
                {plugins > 0 && (
                    <Chip>
                        {plugins} {plugins === 1 ? "plugin" : "plugins"}
                    </Chip>
                )}
                {clis > 0 && (
                    <Chip>
                        {clis} {clis === 1 ? "CLI" : "CLIs"}
                    </Chip>
                )}
            </div>
        </Section>
    );
};

/** Globs holding `(` or `[`, which are glob syntax as well as path text. */
const globsWithBrackets = (agent: CustomAgent) =>
    [...(agent.scope.include ?? []), ...(agent.scope.exclude ?? [])].filter(
        (glob) => /[([]/.test(glob),
    );

export const RunsOn = ({
    agent,
    canEdit,
    onChange,
}: {
    agent: CustomAgent;
    canEdit: boolean;
    onChange: Patch;
}) => {
    const bracketed = globsWithBrackets(agent);
    return (
        <Section
            title="Runs on"
            description="Globs over the files a pull request changes. The agent runs only when one matches; with no include it runs on every pull request.">
            <Field label="Include" hint="e.g. src/payments/**, **/*.sql">
                <TagInput
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
            <Field label="Exclude" hint="e.g. **/*.test.ts, **/generated/**">
                <TagInput
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
            {bracketed.length > 0 && (
                <p role="note" className="text-text-secondary text-xs">
                    {bracketed.join(", ")}: parentheses and brackets are glob
                    syntax, so these also match as literal path text, as in
                    Next.js route folders like (shop) or [id].
                </p>
            )}
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

export const HowItComments = ({
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
            title="How it comments"
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
                <Field label="Format">
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
                <Field label="Minimum severity">
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
                    hint="Empty for no limit">
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
                <Field label="Suggested fix">
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
                label="Writing"
                htmlFor="agent-writing"
                hint="Tone, length, language, what every comment must say. Optional.">
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
        nameOf: (id?: string) => models.find((model) => model.id === id)?.model,
    };
};

/** Run and check model pickers, without the card around them. */
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
                        {model.model}
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
                hint="Reviews the change and verifies its findings, as the main review does.">
                {selector}
            </Field>
        </>
    );
};

export const Models = (props: {
    agent: CustomAgent;
    canEdit: boolean;
    onChange: Patch;
}) => (
    <Section
        title="Models"
        description="By default the routing table decides, under Custom Agents. Pin a model here to override it for this agent only.">
        <ModelsFields {...props} />
    </Section>
);

"use client";

import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { Input } from "@components/ui/input";
import { Switch } from "@components/ui/switch";
import TagInput from "@components/ui/tag-input";
import { Textarea } from "@components/ui/textarea";
import {
    cliIssues,
    CUSTOM_AGENT_LIMITS,
    newCliTool,
} from "@services/custom-agents/drafts";
import type {
    CliToolConfig,
    CliToolSecret,
    CustomAgent,
    CustomAgentResolveReport,
} from "@services/custom-agents/types";
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Chip, Field, Section } from "./field";

type Patch = (patch: (agent: CustomAgent) => CustomAgent) => void;

const McpTools = ({
    agent,
    report,
    canEdit,
    onChange,
}: {
    agent: CustomAgent;
    report?: CustomAgentResolveReport;
    canEdit: boolean;
    onChange: Patch;
}) => {
    const selected = (integrationId: string, tool: string) =>
        !!agent.tools.mcp
            ?.find((entry) => entry.integrationId === integrationId)
            ?.tools.includes(tool);
    const toggle = (integrationId: string, tool: string, on: boolean) =>
        onChange((current) => {
            const mcp = [...(current.tools.mcp ?? [])];
            const index = mcp.findIndex(
                (entry) => entry.integrationId === integrationId,
            );
            const tools = new Set(index >= 0 ? mcp[index].tools : []);
            if (on) tools.add(tool);
            else tools.delete(tool);
            const entry = { integrationId, tools: [...tools] };
            if (index >= 0) mcp[index] = entry;
            else mcp.push(entry);
            return {
                ...current,
                tools: {
                    ...current.tools,
                    mcp: mcp.filter((item) => item.tools.length > 0),
                },
            };
        });

    if (!report) {
        return (
            <p className="text-text-secondary text-xs">
                Reading the connected plugins…
            </p>
        );
    }
    if (report.mcp.status === "unavailable") {
        return <p className="text-warning text-xs">{report.mcp.reason}</p>;
    }
    if (!report.mcp.integrations.length) {
        return (
            <p className="text-text-secondary text-xs">
                No connected plugin has read-only tools. Connect one under
                Plugins.
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-3">
            {report.mcp.integrations.map((integration) => (
                <div
                    key={integration.integrationId}
                    className="flex flex-col gap-1.5">
                    <span className="text-text-primary text-xs font-medium">
                        {integration.name}
                    </span>
                    <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                        {integration.tools.map((tool) => {
                            const id = `mcp-${integration.integrationId}-${tool.name}`;
                            return (
                                <label
                                    key={tool.name}
                                    htmlFor={id}
                                    className="flex cursor-pointer items-start gap-2 text-xs">
                                    <Checkbox
                                        id={id}
                                        disabled={!canEdit}
                                        checked={selected(
                                            integration.integrationId,
                                            tool.name,
                                        )}
                                        onCheckedChange={(checked) =>
                                            toggle(
                                                integration.integrationId,
                                                tool.name,
                                                checked === true,
                                            )
                                        }
                                    />
                                    <span className="flex flex-col">
                                        <span className="text-text-primary font-mono">
                                            {tool.name}
                                        </span>
                                        {tool.description && (
                                            <span className="text-text-tertiary line-clamp-2">
                                                {tool.description}
                                            </span>
                                        )}
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
};

/**
 * Secrets are write-only: a stored one shows as set and can be replaced or
 * removed, never read back.
 */
const SecretsEditor = ({
    secrets,
    disabled,
    onChange,
}: {
    secrets: CliToolSecret[];
    disabled: boolean;
    onChange: (secrets: CliToolSecret[]) => void;
}) => {
    const update = (index: number, patch: Partial<CliToolSecret>) =>
        onChange(
            secrets.map((secret, position) =>
                position === index ? { ...secret, ...patch } : secret,
            ),
        );
    return (
        <div className="flex flex-col gap-2">
            {secrets.map((secret, index) => {
                const stored =
                    !!secret.ciphertext && secret.value === undefined;
                return (
                    <div key={index} className="flex items-center gap-2">
                        <KeyRoundIcon className="text-text-tertiary size-4 shrink-0" />
                        <div className="w-48 shrink-0">
                            <Input
                                size="md"
                                placeholder="LEDGER_TOKEN"
                                value={secret.env}
                                disabled={disabled}
                                onChange={(e) =>
                                    update(index, {
                                        env: e.target.value.toUpperCase(),
                                    })
                                }
                            />
                        </div>
                        <div className="min-w-0 flex-1">
                            {stored ? (
                                <div className="flex items-center gap-2">
                                    <span className="text-text-secondary text-xs">
                                        Stored · hidden
                                    </span>
                                    <Button
                                        size="xs"
                                        variant="helper"
                                        disabled={disabled}
                                        onClick={() =>
                                            update(index, {
                                                ciphertext: undefined,
                                                value: "",
                                            })
                                        }>
                                        Replace
                                    </Button>
                                </div>
                            ) : (
                                <Input
                                    size="md"
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder="Value (write-only)"
                                    value={secret.value ?? ""}
                                    disabled={disabled}
                                    onChange={(e) =>
                                        update(index, {
                                            value: e.target.value,
                                        })
                                    }
                                />
                            )}
                        </div>
                        <Button
                            size="icon-sm"
                            variant="cancel"
                            aria-label="Remove secret"
                            disabled={disabled}
                            onClick={() =>
                                onChange(
                                    secrets.filter(
                                        (_, position) => position !== index,
                                    ),
                                )
                            }>
                            <Trash2Icon />
                        </Button>
                    </div>
                );
            })}
            <Button
                size="xs"
                variant="helper"
                className="w-fit"
                leftIcon={<PlusIcon />}
                disabled={disabled}
                onClick={() => onChange([...secrets, { env: "", value: "" }])}>
                Add secret
            </Button>
        </div>
    );
};

const CliEditor = ({
    cli,
    canEdit,
    onChange,
    onRemove,
}: {
    cli: CliToolConfig;
    canEdit: boolean;
    onChange: (cli: CliToolConfig) => void;
    onRemove: () => void;
}) => {
    const issues = cliIssues(cli);
    const set = (patch: Partial<CliToolConfig>) =>
        onChange({ ...cli, ...patch });

    return (
        <div className="border-card-lv3/60 flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-2">
                <span className="text-text-primary text-sm font-medium">
                    {cli.name || "New CLI"}
                </span>
                <Button
                    size="xs"
                    variant="cancel"
                    leftIcon={<Trash2Icon />}
                    disabled={!canEdit}
                    onClick={onRemove}>
                    Remove
                </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Name">
                    <Input
                        size="md"
                        value={cli.name}
                        disabled={!canEdit}
                        placeholder="ledgerctl"
                        onChange={(e) => set({ name: e.target.value })}
                    />
                </Field>
                <Field label="Binary" hint="What the agent calls.">
                    <Input
                        size="md"
                        value={cli.binary}
                        disabled={!canEdit}
                        placeholder="ledgerctl"
                        onChange={(e) => set({ binary: e.target.value })}
                    />
                </Field>
            </div>
            <Field
                label="Install"
                hint="Pinned to a version or digest. Runs once in the sandbox before the review.">
                <Input
                    size="md"
                    className="font-mono"
                    value={cli.install}
                    disabled={!canEdit}
                    placeholder="npm i -g ledgerctl@1.4.2"
                    onChange={(e) => set({ install: e.target.value })}
                />
            </Field>
            <Field
                label="Allowed command prefixes"
                hint="Every call must start with one of these. Arguments are passed without a shell.">
                <TagInput
                    tags={cli.allowedPrefixes}
                    disabled={!canEdit}
                    placeholder="ledgerctl check"
                    onTagsChange={(allowedPrefixes) => set({ allowedPrefixes })}
                />
            </Field>
            <Field
                label="Allowed domains"
                hint="Hosts the CLI may reach. Everything else is blocked.">
                <TagInput
                    tags={cli.allowedDomains}
                    disabled={!canEdit}
                    placeholder="api.ledger.example"
                    onTagsChange={(allowedDomains) => set({ allowedDomains })}
                />
            </Field>
            <Field
                label="Usage"
                hint="Markdown the agent reads to learn when and how to call it.">
                <Textarea
                    className="min-h-24 font-mono text-xs"
                    value={cli.usage}
                    disabled={!canEdit}
                    onChange={(e) => set({ usage: e.target.value })}
                />
            </Field>
            <div className="flex items-center gap-3">
                <Switch
                    size="sm"
                    checked={cli.runsProjectCode}
                    disabled={!canEdit}
                    onCheckedChange={(runsProjectCode) =>
                        set({
                            runsProjectCode,
                            // Project code could read the env: no secrets.
                            secrets: runsProjectCode ? [] : cli.secrets,
                        })
                    }
                />
                <span className="flex flex-col">
                    <span className="text-text-primary text-xs font-medium">
                        Runs project code
                    </span>
                    <span className="text-text-tertiary text-xs">
                        Tests, builds, linters that load the repository. Such a
                        CLI never receives secrets.
                    </span>
                </span>
            </div>
            {!cli.runsProjectCode && (
                <Field
                    label="Secrets"
                    hint="Only in this CLI's environment, masked in its output, never in the prompt.">
                    <SecretsEditor
                        secrets={cli.secrets ?? []}
                        disabled={!canEdit}
                        onChange={(secrets) => set({ secrets })}
                    />
                </Field>
            )}
            {issues.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {issues.map((issue) => (
                        <Chip key={issue} tone="warning">
                            {issue}
                        </Chip>
                    ))}
                </div>
            )}
        </div>
    );
};

export const ToolsCard = ({
    agent,
    report,
    canEdit,
    onChange,
}: {
    agent: CustomAgent;
    report?: CustomAgentResolveReport;
    canEdit: boolean;
    onChange: Patch;
}) => {
    const clis = agent.tools.cli ?? [];
    const setClis = (next: CliToolConfig[]) =>
        onChange((current) => ({
            ...current,
            tools: { ...current.tools, cli: next },
        }));

    return (
        <Section
            title="Tools"
            description="What the agent can run besides reading the code. Every tool is read-only towards your systems.">
            <Field
                label="Structural search (ast-grep rules)"
                hint={
                    report?.astGrep.ruleCount
                        ? `${report.astGrep.ruleCount} rules: ${report.astGrep.ruleIds.join(", ")}. A rule match is proof; it needs no model check.`
                        : "Rule YAML the agent may run. A match counts as proof."
                }>
                <Textarea
                    className="min-h-24 font-mono text-xs"
                    value={agent.tools.astGrepConfig ?? ""}
                    disabled={!canEdit}
                    placeholder={
                        "id: no-float-money\nlanguage: typescript\nrule:\n  pattern: parseFloat($A)"
                    }
                    onChange={(e) =>
                        onChange((current) => ({
                            ...current,
                            tools: {
                                ...current.tools,
                                astGrepConfig: e.target.value || undefined,
                            },
                        }))
                    }
                />
            </Field>

            <Field
                label="MCP tools (read-only)"
                hint="Only tools a plugin marks read-only are listed; write tools are never offered.">
                <McpTools
                    agent={agent}
                    report={report}
                    canEdit={canEdit}
                    onChange={onChange}
                />
            </Field>

            <Field
                label="CLIs"
                hint={`Your team's command-line tools, installed in an isolated sandbox. Up to ${CUSTOM_AGENT_LIMITS.maxCliTools}.`}>
                <div className="flex flex-col gap-3">
                    {clis.map((cli, index) => (
                        <CliEditor
                            key={index}
                            cli={cli}
                            canEdit={canEdit}
                            onChange={(next) =>
                                setClis(
                                    clis.map((item, position) =>
                                        position === index ? next : item,
                                    ),
                                )
                            }
                            onRemove={() =>
                                setClis(
                                    clis.filter(
                                        (_, position) => position !== index,
                                    ),
                                )
                            }
                        />
                    ))}
                    <Button
                        size="xs"
                        variant="helper"
                        className="w-fit"
                        leftIcon={<PlusIcon />}
                        disabled={
                            !canEdit ||
                            clis.length >= CUSTOM_AGENT_LIMITS.maxCliTools
                        }
                        onClick={() => setClis([...clis, newCliTool()])}>
                        Add CLI
                    </Button>
                </div>
            </Field>
        </Section>
    );
};

"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import { Skeleton } from "@components/ui/skeleton";
import { Switch } from "@components/ui/switch";
import TagInput from "@components/ui/tag-input";
import { Textarea } from "@components/ui/textarea";
import {
    astGrepHint,
    cliIssues,
    CUSTOM_AGENT_LIMITS,
    newCliTool,
} from "@services/custom-agents/drafts";
import {
    mcpPluginSelection,
    setMcpPlugin,
    toggleMcpTool,
} from "@services/custom-agents/mcp-selection";
import type {
    CliToolConfig,
    CliToolSecret,
    CustomAgent,
    CustomAgentMcpTools,
    CustomAgentResolveReport,
    ReadOnlyMcpIntegration,
} from "@services/custom-agents/types";
import { KeyRoundIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { Chip, Field, Section } from "./field";

type Patch = (patch: (agent: CustomAgent) => CustomAgent) => void;

/** One plugin: on grants every read tool; Customize narrows it. */
const McpPluginRow = ({
    integration,
    mcp,
    canEdit,
    onChange,
}: {
    integration: ReadOnlyMcpIntegration;
    mcp: CustomAgentMcpTools[];
    canEdit: boolean;
    onChange: (mcp: CustomAgentMcpTools[]) => void;
}) => {
    const available = integration.tools.map((tool) => tool.name);
    const { on, all, selected } = mcpPluginSelection(
        mcp,
        integration.integrationId,
        available,
    );
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const reachable = available.length > 0;
    const needle = query.trim().toLowerCase();
    const shown = needle
        ? integration.tools.filter(
              (tool) =>
                  tool.name.toLowerCase().includes(needle) ||
                  tool.description?.toLowerCase().includes(needle),
          )
        : integration.tools;
    const switchId = `mcp-${integration.integrationId}`;

    return (
        <Collapsible
            open={on && open}
            onOpenChange={setOpen}
            className={cn(
                "rounded-xl transition-colors",
                on ? "bg-card-lv2" : "bg-card-lv2/50",
            )}>
            <div className="flex items-center gap-3 px-4 py-3">
                <Switch
                    id={switchId}
                    size="sm"
                    aria-label={`Use ${integration.name}`}
                    checked={on}
                    disabled={!canEdit || !reachable}
                    onCheckedChange={(checked) => {
                        onChange(
                            setMcpPlugin(
                                mcp,
                                integration.integrationId,
                                checked,
                            ),
                        );
                        if (!checked) setOpen(false);
                    }}
                />
                <label
                    htmlFor={switchId}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col">
                    <span className="text-text-primary text-sm font-medium">
                        {integration.name}
                    </span>
                    <span className="text-text-secondary text-xs">
                        {!reachable
                            ? "Unreachable right now, so no tools to offer"
                            : on && !all
                              ? `${selected.length} of ${available.length} read tools`
                              : `${available.length} read ${available.length === 1 ? "tool" : "tools"}`}
                    </span>
                </label>
                {on && (
                    <CollapsibleTrigger asChild>
                        <Button
                            size="xs"
                            variant="cancel"
                            rightIcon={<CollapsibleIndicator />}>
                            {all ? "Customize" : "Customized"}
                        </Button>
                    </CollapsibleTrigger>
                )}
            </div>
            <CollapsibleContent>
                <div className="flex flex-col gap-2 px-4 pb-4">
                    <div className="flex items-center gap-2">
                        <div className="flex-1">
                            <Input
                                size="md"
                                leftIcon={<SearchIcon />}
                                placeholder={`Filter ${available.length} tools`}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                        </div>
                        {!all && (
                            <Button
                                size="xs"
                                variant="helper"
                                disabled={!canEdit}
                                onClick={() =>
                                    onChange(
                                        setMcpPlugin(
                                            mcp,
                                            integration.integrationId,
                                            true,
                                        ),
                                    )
                                }>
                                Use every tool
                            </Button>
                        )}
                    </div>
                    <ul
                        aria-label={`${integration.name} tools`}
                        className="flex max-h-72 flex-col overflow-y-auto">
                        {shown.map((tool) => {
                            const id = `${switchId}-${tool.name}`;
                            return (
                                <li key={tool.name}>
                                    <label
                                        htmlFor={id}
                                        title={tool.description}
                                        className="hover:bg-card-lv3/40 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5">
                                        <Checkbox
                                            id={id}
                                            size="icon-xs"
                                            disabled={!canEdit}
                                            checked={selected.includes(
                                                tool.name,
                                            )}
                                            onCheckedChange={(checked) =>
                                                onChange(
                                                    toggleMcpTool(
                                                        mcp,
                                                        integration.integrationId,
                                                        tool.name,
                                                        checked === true,
                                                        available,
                                                    ),
                                                )
                                            }
                                        />
                                        <span className="text-text-primary min-w-0 shrink truncate font-mono text-xs sm:w-56 sm:shrink-0">
                                            {tool.name}
                                        </span>
                                        <span className="text-text-tertiary hidden min-w-0 flex-1 truncate text-xs sm:block">
                                            {tool.description}
                                        </span>
                                    </label>
                                </li>
                            );
                        })}
                        {shown.length === 0 && (
                            <li className="text-text-tertiary px-2 py-1.5 text-xs">
                                No tool matches “{query.trim()}”.
                            </li>
                        )}
                    </ul>
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
};

const McpTools = ({
    agent,
    report,
    loading,
    canEdit,
    onChange,
}: {
    agent: CustomAgent;
    report?: CustomAgentResolveReport;
    loading: boolean;
    canEdit: boolean;
    onChange: Patch;
}) => {
    const mcp = agent.tools.mcp ?? [];
    const setMcp = (next: CustomAgentMcpTools[]) =>
        onChange((current) => ({
            ...current,
            tools: { ...current.tools, mcp: next },
        }));

    if (!report && loading) {
        return (
            <div className="flex flex-col gap-2">
                <Skeleton className="h-14 w-full rounded-xl" />
                <Skeleton className="h-14 w-full rounded-xl" />
            </div>
        );
    }
    if (!report) {
        return (
            <p className="text-text-secondary text-xs">
                Couldn&apos;t list the connected plugins right now. Reload the
                page to try again.
            </p>
        );
    }
    if (report.mcp.status === "unavailable") {
        return <p className="text-warning text-xs">{report.mcp.reason}</p>;
    }
    if (!report.mcp.integrations.length) {
        return (
            <p className="text-text-secondary text-xs">
                No plugin with read tools is connected.{" "}
                <Link href="/settings/plugins">Connect one in Plugins</Link>.
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-2">
            {report.mcp.integrations.map((integration) => (
                <McpPluginRow
                    key={integration.integrationId}
                    integration={integration}
                    mcp={mcp}
                    canEdit={canEdit}
                    onChange={setMcp}
                />
            ))}
        </div>
    );
};

/** "Linear, Azure DevOps · 54 tools", or nothing when no plugin is on. */
const mcpSummary = (agent: CustomAgent, report?: CustomAgentResolveReport) => {
    if (report?.mcp.status !== "ok") return undefined;
    const on = report.mcp.integrations
        .map((integration) => ({
            name: integration.name,
            ...mcpPluginSelection(
                agent.tools.mcp ?? [],
                integration.integrationId,
                integration.tools.map((tool) => tool.name),
            ),
        }))
        .filter((plugin) => plugin.on);
    if (!on.length) return undefined;
    const tools = on.reduce(
        (total, plugin) => total + plugin.selected.length,
        0,
    );
    return `${on.map((plugin) => plugin.name).join(", ")} · ${tools} ${tools === 1 ? "tool" : "tools"}`;
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

type ToolsProps = {
    agent: CustomAgent;
    report?: CustomAgentResolveReport;
    /** The resolve check is running and has no report yet. */
    loading: boolean;
    canEdit: boolean;
    onChange: Patch;
};

/** The plugins the agent may read from, one row per connected plugin. */
export const PluginsField = ({
    agent,
    report,
    loading,
    canEdit,
    onChange,
}: ToolsProps) => (
    <Field label="Plugins">
        <span className="text-text-tertiary -mt-1 text-xs">
            Systems the agent may look things up in while it reviews. Only read
            tools are offered; write tools never are.
        </span>
        <McpTools
            agent={agent}
            report={report}
            loading={loading}
            canEdit={canEdit}
            onChange={onChange}
        />
        {mcpSummary(agent, report) && (
            <span className="text-text-secondary text-xs">
                On: {mcpSummary(agent, report)}
            </span>
        )}
    </Field>
);

/** The agent's CLIs and the button that adds one. */
export const ClisField = ({
    agent,
    canEdit,
    onChange,
}: Pick<ToolsProps, "agent" | "canEdit" | "onChange">) => {
    const clis = agent.tools.cli ?? [];
    const setClis = (next: CliToolConfig[]) =>
        onChange((current) => ({
            ...current,
            tools: { ...current.tools, cli: next },
        }));

    return (
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
    );
};

export const ToolsCard = (props: ToolsProps) => {
    const { agent, report, canEdit, onChange } = props;
    // Structural search is for teams that already write ast-grep rules:
    // folded away unless this agent has one.
    const [advancedOpen, setAdvancedOpen] = useState(
        !!agent.tools.astGrepConfig?.trim(),
    );

    return (
        <Section
            title="Tools"
            description="What the agent can run besides reading the code. Every tool is read-only towards your systems.">
            <PluginsField {...props} />
            <ClisField agent={agent} canEdit={canEdit} onChange={onChange} />

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger asChild>
                    <button
                        type="button"
                        className="text-text-secondary hover:text-text-primary flex items-center gap-2 text-xs font-medium">
                        Advanced
                        <CollapsibleIndicator />
                    </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3 pb-0">
                    <Field
                        label="Structural search (ast-grep rules)"
                        htmlFor="agent-ast-grep"
                        hint={astGrepHint(agent.tools.astGrepConfig, report)}>
                        <Textarea
                            id="agent-ast-grep"
                            className="min-h-24 font-mono text-xs"
                            value={agent.tools.astGrepConfig ?? ""}
                            disabled={!canEdit}
                            placeholder={
                                "id: no-float-money\nlanguage: typescript\nrule:\n  pattern: parseFloat($A)\n\nor a rule file path: rules/review.yml"
                            }
                            onChange={(e) =>
                                onChange((current) => ({
                                    ...current,
                                    tools: {
                                        ...current.tools,
                                        astGrepConfig:
                                            e.target.value || undefined,
                                    },
                                }))
                            }
                        />
                    </Field>
                </CollapsibleContent>
            </Collapsible>
        </Section>
    );
};

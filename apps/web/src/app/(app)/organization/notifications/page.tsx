"use client";

import { useMemo, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import { Switch } from "@components/ui/switch";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@components/ui/tabs";
import { toast } from "@components/ui/toaster/use-toast";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useAsyncAction } from "@hooks/use-async-action";
import { RotateCcwIcon, Save, Undo2 } from "lucide-react";
import {
    Controller,
    FormProvider,
    useFormContext,
    useForm,
    useWatch,
} from "react-hook-form";
import { cn } from "src/core/utils/components";

import {
    useNotificationConfig,
    useRoutingRules,
    useUpsertRoutingRules,
} from "@services/notifications/hooks";
import type {
    EventCatalogEntry,
    EventCriticality,
    NotificationConfig,
    RoutingRule,
    UpsertRoutingRulePayload,
} from "@services/notifications/types";

type EventDef = EventCatalogEntry;

/**
 * Presentational map for criticality badges. The labels themselves
 * come from the backend; only the Tailwind color classes live here
 * since they're pure presentation tokens.
 */
const CRITICALITY_BADGE_CLASS: Record<EventCriticality, string> = {
    system: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
    critical: "bg-red-500/15 text-red-400 border-red-500/30",
    transactional: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    informational: "bg-blue-500/15 text-blue-400 border-blue-500/30",
};

const ROW_GRID =
    "grid items-center gap-4 px-4 py-3";

type ChannelMap = Record<string, boolean>;
type EventMap = Record<string, ChannelMap>;
type FormValues = {
    rules: Record<string, EventMap>;
};

// Event names contain dots (e.g. "auth.email_confirmation"), which collide
// with react-hook-form's dot-notation field paths. Encode dots in form keys
// and decode them when sending payloads back to the server.
const toFormKey = (event: string) => event.replaceAll(".", "__");
const fromFormKey = (key: string) => key.replaceAll("__", ".");

/**
 * Whether a role gets the event's catalog defaults when there is no stored
 * rule for it (and no wildcard row). Mirrors the dispatcher's fallback: a
 * declared default role (or an event with no declared roles) defaults on;
 * every other role defaults off. Once a "*" or role row exists it takes over —
 * any role is freely configurable.
 */
const isDefaultRole = (ev: EventDef, roleValue: string) =>
    roleValue === "*" ||
    !ev.defaultRoles ||
    ev.defaultRoles.includes(roleValue);

const buildDefaults = (
    rules: RoutingRule[],
    configurableEvents: EventDef[],
    roles: NotificationConfig["roles"],
    channels: NotificationConfig["channels"],
): FormValues => {
    const byEvent: Record<string, Record<string, Record<string, boolean>>> = {};
    for (const rule of rules) {
        if (!byEvent[rule.event]) byEvent[rule.event] = {};
        byEvent[rule.event][rule.role] = rule.channels;
    }

    const result: FormValues = { rules: {} };
    for (const role of roles) {
        const roleEntry: EventMap = {};
        for (const ev of configurableEvents) {
            const eventRules = byEvent[ev.event] ?? {};
            // Lookup order, mirroring the dispatcher's runtime resolution:
            //   1. Role-specific stored rule wins.
            //   2. The wildcard ('*') rule — a literal baseline for every role.
            //   3. No rule: catalog default for a default role, else off.
            const source =
                eventRules[role.value] ??
                eventRules["*"] ??
                (isDefaultRole(ev, role.value)
                    ? ev.defaultChannels
                    : undefined);
            const channelValues: ChannelMap = {};
            for (const ch of channels) {
                channelValues[ch.value] = source?.[ch.value] ?? false;
            }
            roleEntry[toFormKey(ev.event)] = channelValues;
        }
        result.rules[role.value] = roleEntry;
    }
    return result;
};

export default function NotificationsConfigPage() {
    const { data: rules, isLoading: rulesLoading } = useRoutingRules();
    const { data: config, isLoading: configLoading } = useNotificationConfig();

    if (rulesLoading || configLoading || !rules || !config) {
        return <NotificationsSkeleton />;
    }

    return <NotificationsForm rules={rules} config={config} />;
}

function NotificationsSkeleton() {
    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Skeleton className="h-7 w-56" />
                    <Skeleton className="mt-2 h-4 w-80" />
                </Page.TitleContainer>
                <Page.HeaderActions>
                    <Skeleton className="h-10 w-32" />
                    <Skeleton className="h-10 w-32" />
                </Page.HeaderActions>
            </Page.Header>
            <Page.Content>
                <div className="flex flex-col gap-4">
                    <Skeleton className="h-10 w-full" />
                    <div className="bg-card-lv2 divide-y rounded-xl">
                        {[0, 1, 2, 3].map((i) => (
                            <div
                                key={i}
                                className="flex items-center justify-between px-4 py-3">
                                <Skeleton className="h-4 w-48" />
                                <div className="flex gap-6">
                                    <Skeleton className="h-5 w-9 rounded-full" />
                                    <Skeleton className="h-5 w-9 rounded-full" />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </Page.Content>
        </Page.Root>
    );
}

function NotificationsForm({
    rules,
    config,
}: {
    rules: RoutingRule[];
    config: NotificationConfig;
}) {
    const upsertMutation = useUpsertRoutingRules();
    const [selectedRole, setSelectedRole] = useState<string>(
        config.roles[0]?.value ?? "*",
    );

    const { channels, roles, criticalityLabels } = useMemo(
        () => ({
            channels: config.channels,
            roles: config.roles,
            criticalityLabels: Object.fromEntries(
                config.criticalities.map((c) => [c.value, c.label]),
            ) as Record<EventCriticality, string>,
        }),
        [config],
    );

    const categoryLabels = useMemo(
        () =>
            Object.fromEntries(
                config.categories.map((c) => [c.value, c.label]),
            ) as Record<string, string>,
        [config.categories],
    );

    const { configurableEvents, groupedEvents } = useMemo(() => {
        const configurableEvents: EventDef[] = [];
        for (const ev of config.events) {
            if (ev.criticality === "system") continue;
            configurableEvents.push(ev);
        }

        const groups = new Map<string, EventDef[]>();
        for (const ev of configurableEvents) {
            const list = groups.get(ev.category) ?? [];
            list.push(ev);
            groups.set(ev.category, list);
        }

        return {
            configurableEvents,
            groupedEvents: [...groups.entries()],
        };
    }, [config.events]);

    const defaults = useMemo(
        () => buildDefaults(rules, configurableEvents, roles, channels),
        [rules, configurableEvents, roles, channels],
    );

    // Set of "${role}|${event}" pairs that currently have an explicit DB row.
    // Used at save time to know whether matching-the-wildcard means "delete
    // the override row" (it exists) or "do nothing" (it never existed).
    const originalOverrides = useMemo(() => {
        const set = new Set<string>();
        for (const r of rules) {
            if (r.role !== "*") set.add(`${r.role}|${r.event}`);
        }
        return set;
    }, [rules]);

    const form = useForm<FormValues>({
        mode: "onChange",
        defaultValues: defaults,
    });

    const {
        handleSubmit,
        reset,
        formState: { isDirty, dirtyFields },
    } = form;

    const [saveSettings, { loading: isSaving }] = useAsyncAction(
        async (data: FormValues) => {
            try {
                const payload: UpsertRoutingRulePayload[] = [];
                const dirtyRules = dirtyFields.rules ?? {};

                for (const role of Object.keys(dirtyRules)) {
                    const dirtyEvents = dirtyRules[role] ?? {};
                    for (const key of Object.keys(dirtyEvents)) {
                        const event = fromFormKey(key);
                        const channelValues = data.rules[role][key];

                        if (role === "*") {
                            payload.push({
                                event,
                                role,
                                channels: channelValues,
                            });
                            continue;
                        }

                        const wildcardChannels = data.rules["*"]?.[key];
                        const matchesWildcard =
                            wildcardChannels &&
                            channels.every(
                                (ch) =>
                                    channelValues[ch.value] ===
                                    wildcardChannels[ch.value],
                            );

                        if (matchesWildcard) {
                            // Override has been reverted to inherit from
                            // wildcard. Only emit a delete if the row
                            // actually exists on the server.
                            if (originalOverrides.has(`${role}|${event}`)) {
                                payload.push({
                                    event,
                                    role,
                                    channels: channelValues,
                                    delete: true,
                                });
                            }
                            continue;
                        }

                        payload.push({
                            event,
                            role,
                            channels: channelValues,
                        });
                    }
                }

                if (payload.length === 0) {
                    reset(data);
                    return;
                }

                await upsertMutation.mutateAsync(payload);
                reset(data);

                toast({
                    description: "Notification settings saved",
                    variant: "success",
                });
            } catch (error: any) {
                toast({
                    title: "Error",
                    description: error.message,
                    variant: "danger",
                });
            }
        },
    );

    // Grid template for table rows: event-label column flex + one fixed
    // column per channel. Re-uses the standard row padding/gap from
    // ROW_GRID. Computed once per render of the form.
    const rowGridStyle = useMemo(
        () => ({
            gridTemplateColumns: `1fr repeat(${channels.length}, 100px)`,
        }),
        [channels.length],
    );

    return (
        <Page.Root>
            <FormProvider {...form}>
                <form onSubmit={handleSubmit(saveSettings)}>
                    <Page.Header>
                        <Page.TitleContainer>
                            <Page.Title>Notification settings</Page.Title>
                            <Page.Description>
                                Configure which notification channels are
                                active for each event and role.
                            </Page.Description>
                        </Page.TitleContainer>
                        <Page.HeaderActions>
                            <Button
                                type="button"
                                size="md"
                                variant="secondary"
                                leftIcon={<RotateCcwIcon />}
                                onClick={() => reset()}
                                disabled={!isDirty || isSaving}>
                                Reset changes
                            </Button>
                            <Button
                                type="submit"
                                size="md"
                                variant="primary"
                                leftIcon={<Save />}
                                disabled={!isDirty || isSaving}
                                loading={isSaving}>
                                Save settings
                            </Button>
                        </Page.HeaderActions>
                    </Page.Header>

                    <Page.Content className="mt-4">
                        <Tabs
                            value={selectedRole}
                            onValueChange={setSelectedRole}>
                            <TabsList>
                                {roles.map((role) => (
                                    <TabsTrigger
                                        key={role.value}
                                        value={role.value}
                                        type="button">
                                        {role.label}
                                    </TabsTrigger>
                                ))}
                            </TabsList>

                            {roles.map((role) => (
                                <TabsContent
                                    key={role.value}
                                    value={role.value}>
                                    <RolePanel
                                        role={role.value}
                                        groupedEvents={groupedEvents}
                                        channels={channels}
                                        categoryLabels={categoryLabels}
                                        criticalityLabels={criticalityLabels}
                                        rowGridStyle={rowGridStyle}
                                    />
                                </TabsContent>
                            ))}
                        </Tabs>
                    </Page.Content>
                </form>
            </FormProvider>
        </Page.Root>
    );
}

interface RowProps {
    channels: NotificationConfig["channels"];
    rowGridStyle: React.CSSProperties;
}

function RolePanel({
    role,
    groupedEvents,
    channels,
    categoryLabels,
    criticalityLabels,
    rowGridStyle,
}: RowProps & {
    role: string;
    groupedEvents: Array<[string, EventDef[]]>;
    categoryLabels: Record<string, string>;
    criticalityLabels: Record<EventCriticality, string>;
}) {
    return (
        <div className="mt-4 flex flex-col gap-6">
            {groupedEvents.map(([category, events]) => (
                <CategorySection
                    key={category}
                    role={role}
                    categoryValue={category}
                    categoryLabel={
                        categoryLabels[category] ?? prettifyFallback(category)
                    }
                    events={events}
                    channels={channels}
                    criticalityLabels={criticalityLabels}
                    rowGridStyle={rowGridStyle}
                />
            ))}
        </div>
    );
}

function CategorySection({
    role,
    categoryLabel,
    events,
    channels,
    criticalityLabels,
    rowGridStyle,
}: RowProps & {
    role: string;
    categoryValue: string;
    categoryLabel: string;
    events: EventDef[];
    criticalityLabels: Record<EventCriticality, string>;
}) {
    return (
        <section className="flex flex-col gap-3">
            <Heading variant="h3">{categoryLabel}</Heading>

            <div className="bg-card-lv2 divide-y rounded-xl">
                <CategoryHeaderRow
                    channels={channels}
                    rowGridStyle={rowGridStyle}
                />
                {events.map((ev) => (
                    <EventRow
                        key={ev.event}
                        role={role}
                        event={ev}
                        channels={channels}
                        criticalityLabels={criticalityLabels}
                        rowGridStyle={rowGridStyle}
                    />
                ))}
            </div>
        </section>
    );
}

function CategoryHeaderRow({ channels, rowGridStyle }: RowProps) {
    return (
        <div className={ROW_GRID} style={rowGridStyle}>
            <span className="text-text-tertiary text-xs font-medium">
                Event
            </span>
            {channels.map((ch) => (
                <span
                    key={ch.value}
                    className="text-text-tertiary text-center text-xs font-medium">
                    {ch.label}
                </span>
            ))}
        </div>
    );
}

function EventRow({
    role,
    event,
    channels,
    criticalityLabels,
    rowGridStyle,
}: RowProps & {
    role: string;
    event: EventDef;
    criticalityLabels: Record<EventCriticality, string>;
}) {
    const badgeLabel =
        criticalityLabels[event.criticality] ?? event.criticality;
    const badgeClass = CRITICALITY_BADGE_CLASS[event.criticality];

    return (
        <div className={ROW_GRID} style={rowGridStyle}>
            <div className="flex items-center gap-2">
                <span className="text-text-primary text-pretty text-sm">
                    {event.label}
                </span>
                <span
                    className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        badgeClass,
                    )}>
                    {badgeLabel}
                </span>
                <OverrideIndicator
                    role={role}
                    event={event}
                    channels={channels}
                />
            </div>

            {channels.map((ch) => (
                <div key={ch.value} className="flex justify-center">
                    <ChannelToggle role={role} event={event} channel={ch} />
                </div>
            ))}
        </div>
    );
}

function OverrideIndicator({
    role,
    event,
    channels,
}: {
    role: string;
    event: EventDef;
    channels: NotificationConfig["channels"];
}) {
    const form = useFormContext<FormValues>();
    const eventKey = toFormKey(event.event);

    const wildcardChannels = useWatch({
        control: form.control,
        name: `rules.*.${eventKey}`,
    }) as ChannelMap | undefined;

    const roleChannels = useWatch({
        control: form.control,
        name: `rules.${role}.${eventKey}`,
    }) as ChannelMap | undefined;

    if (role === "*" || !wildcardChannels || !roleChannels) return null;

    const isOverridden = channels.some(
        (ch) => roleChannels[ch.value] !== wildcardChannels[ch.value],
    );
    if (!isOverridden) return null;

    const handleRevert = () => {
        form.setValue(`rules.${role}.${eventKey}`, wildcardChannels, {
            shouldDirty: true,
        });
    };

    return (
        <div className="flex items-center gap-1.5">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Badge className="cursor-default px-1.5 py-0.5 text-xs">
                        Overridden
                    </Badge>
                </TooltipTrigger>
                <TooltipContent>
                    <p>This overrides the All Roles config.</p>
                </TooltipContent>
            </Tooltip>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        type="button"
                        onClick={handleRevert}
                        aria-label={`Revert ${event.label} to All Roles config`}
                        className="text-text-tertiary hover:text-text-primary transition-colors duration-150 ease-out">
                        <Undo2 className="size-3.5" />
                    </button>
                </TooltipTrigger>
                <TooltipContent>
                    <p>Revert to All Roles config</p>
                </TooltipContent>
            </Tooltip>
        </div>
    );
}

function ChannelToggle({
    role,
    event,
    channel,
}: {
    role: string;
    event: EventDef;
    channel: NotificationConfig["channels"][number];
}) {
    return (
        <Controller<FormValues>
            name={`rules.${role}.${toFormKey(event.event)}.${channel.value}`}
            render={({ field }) => (
                <Switch
                    size="sm"
                    aria-label={`${channel.label} for ${event.label}`}
                    checked={field.value as unknown as boolean}
                    onCheckedChange={field.onChange}
                />
            )}
        />
    );
}

/**
 * Fallback for unrecognized category values returned by the backend.
 * The backend already declares labels for every known category; this
 * exists so a newly-added category without an explicit label still
 * renders somewhat readably until the catalog is updated.
 */
function prettifyFallback(value: string) {
    return value
        .split("_")
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" ");
}

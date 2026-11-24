"use client";

import { useRouter } from "next/navigation";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Page } from "@components/ui/page";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAsyncAction } from "@hooks/use-async-action";
import { createOrUpdateOrganizationParameter } from "@services/organizationParameters/fetch";
import type { FixedEgressIp } from "@services/organizationParameters/fixedEgressIp";
import {
    OrganizationParametersAutoJoinConfig,
    OrganizationParametersConfigKey,
    OrganizationParametersReviewCommandModesConfig,
    Timezone,
} from "@services/parameters/types";
import { Controller, useForm, useWatch } from "react-hook-form";
import { publicDomainsSet } from "src/core/utils/email";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";
import { z } from "zod";

import { FixedEgressIpCard } from "./_components/fixed-egress-ip-card";
import { SettingsGroup, SettingsRow } from "./_components/settings-group";

const timezoneOptions = [
    { value: Timezone.NEW_YORK, title: "New York" },
    { value: Timezone.SAO_PAULO, title: "São Paulo" },
] satisfies Array<{ value: Timezone; title: string }>;

const createSettingsSchema = (userDomain: string) =>
    z
        .object({
            timezone: z.nativeEnum(Timezone),
            autoJoinConfig: z.object({
                enabled: z.boolean(),
                domains: z.array(z.string()),
            }),
            reviewCommandModes: z.object({
                heavyBlocked: z.boolean(),
                ultraBlocked: z.boolean(),
            }),
        })
        .superRefine((data, ctx) => {
            if (data.autoJoinConfig.enabled) {
                const { domains } = data.autoJoinConfig;
                const validDomains = domains.filter((d) => d);

                if (validDomains.length === 0) {
                    ctx.addIssue({
                        code: "custom",
                        message: "At least one domain is required.",
                        path: ["autoJoinConfig", "domains"],
                    });
                    return;
                }

                const lowercaseDomains = validDomains.map((d) =>
                    d.toLowerCase(),
                );
                const isPublicDomain = lowercaseDomains.some((d) =>
                    publicDomainsSet.has(d),
                );

                if (isPublicDomain) {
                    ctx.addIssue({
                        code: "custom",
                        message: "Public domains are not allowed.",
                        path: ["autoJoinConfig", "domains"],
                    });
                }

                if (validDomains.some((domain) => domain !== userDomain)) {
                    ctx.addIssue({
                        code: "custom",
                        message: "You can only add your own domain.",
                        path: ["autoJoinConfig", "domains"],
                    });
                }
            }
        });

type SettingsFormData = z.infer<ReturnType<typeof createSettingsSchema>>;

export const GeneralOrganizationSettingsPage = (props: {
    email: string;
    timezone: Timezone;
    autoJoinConfig: OrganizationParametersAutoJoinConfig;
    /** Undefined when they could not be read: shown unknown, never saved. */
    reviewCommandModes?: Required<OrganizationParametersReviewCommandModesConfig>;
    /** Saved on its own by its card, outside this form. */
    fixedEgressIp: FixedEgressIp;
    fixedEgressIpLoadFailed?: boolean;
}) => {
    const router = useRouter();
    const userDomain = props.email.split("@")[1];

    const form = useForm<SettingsFormData>({
        mode: "onChange",
        resolver: zodResolver(createSettingsSchema(userDomain)),
        defaultValues: {
            timezone: props.timezone,
            autoJoinConfig: props.autoJoinConfig,
            reviewCommandModes: props.reviewCommandModes ?? {
                heavyBlocked: false,
                ultraBlocked: false,
            },
        },
    });

    const {
        control,
        handleSubmit,
        formState: { errors, isDirty, isValid },
    } = form;

    const autoJoinEnabled = useWatch({
        control,
        name: "autoJoinConfig.enabled",
    });

    const [saveSettings, { loading: isLoadingSubmitButton }] = useAsyncAction(
        async (data: SettingsFormData) => {
            try {
                const promises: Promise<any>[] = [];

                if (data.timezone !== props.timezone) {
                    promises.push(
                        createOrUpdateOrganizationParameter(
                            OrganizationParametersConfigKey.TIMEZONE_CONFIG,
                            data.timezone,
                        ),
                    );
                }

                if (
                    JSON.stringify(data.autoJoinConfig) !==
                    JSON.stringify(props.autoJoinConfig)
                ) {
                    promises.push(
                        createOrUpdateOrganizationParameter(
                            OrganizationParametersConfigKey.AUTO_JOIN_CONFIG,
                            data.autoJoinConfig,
                        ),
                    );
                }

                if (
                    props.reviewCommandModes &&
                    (data.reviewCommandModes.heavyBlocked !==
                        props.reviewCommandModes.heavyBlocked ||
                        data.reviewCommandModes.ultraBlocked !==
                            props.reviewCommandModes.ultraBlocked)
                ) {
                    promises.push(
                        createOrUpdateOrganizationParameter(
                            OrganizationParametersConfigKey.REVIEW_COMMAND_MODES_CONFIG,
                            data.reviewCommandModes,
                        ),
                    );
                }

                if (promises.length === 0) return;

                await Promise.all(promises);
                await revalidateServerSidePath("/organization/general");
                router.refresh();

                toast({ description: "Settings saved", variant: "success" });
            } catch (error: any) {
                toast({
                    title: "Error",
                    description: error.message,
                    variant: "danger",
                });
                console.error(error);
            }
        },
    );

    return (
        <Page.Root>
            <form
                className="flex flex-col gap-6"
                onSubmit={handleSubmit(saveSettings)}>
                <Page.Header sticky>
                    <Page.TitleContainer>
                        <Page.Title>General settings</Page.Title>
                        <Page.Description>
                            Settings that apply to every team in this
                            organization.
                        </Page.Description>
                    </Page.TitleContainer>
                    <Page.SaveActions
                        isDirty={isDirty}
                        isSaving={isLoadingSubmitButton}
                        canSave={isValid}
                        onReset={() => form.reset()}
                        onSave={handleSubmit(saveSettings)}
                    />
                </Page.Header>

                <Page.Content className="flex max-w-3xl flex-col gap-10">
                    <SettingsGroup title="Organization">
                        <SettingsRow
                            title="Timezone"
                            description="Dates and times for this organization follow it."
                            htmlFor="timezone"
                            control={
                                <Controller
                                    name="timezone"
                                    control={control}
                                    render={({ field }) => (
                                        <Select
                                            value={field.value}
                                            onValueChange={field.onChange}>
                                            <SelectTrigger
                                                id="timezone"
                                                className="w-48">
                                                <SelectValue placeholder="Select timezone" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {timezoneOptions.map((opt) => (
                                                    <SelectItem
                                                        key={opt.value}
                                                        value={opt.value}>
                                                        {opt.title}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    )}
                                />
                            }
                        />
                    </SettingsGroup>

                    <SettingsGroup title="Members">
                        <SettingsRow
                            title="Auto join by email domain"
                            description="People who sign up with your company's email domain join this organization on their own."
                            htmlFor="autoJoinConfig.enabled"
                            control={
                                <Controller
                                    name="autoJoinConfig.enabled"
                                    control={control}
                                    render={({ field }) => (
                                        <Switch
                                            id={field.name}
                                            checked={field.value}
                                            onCheckedChange={(v) => {
                                                field.onChange(v);
                                                form.trigger(
                                                    "autoJoinConfig.domains",
                                                );
                                            }}
                                        />
                                    )}
                                />
                            }>
                            {autoJoinEnabled && (
                                <Controller
                                    name="autoJoinConfig.domains"
                                    control={control}
                                    render={({ field, fieldState }) => (
                                        <FormControl.Root>
                                            <FormControl.Label htmlFor="autoJoinConfig.domains">
                                                Domains
                                            </FormControl.Label>
                                            <FormControl.Input>
                                                <Input
                                                    id="autoJoinConfig.domains"
                                                    placeholder="e.g., yourcompany.com"
                                                    error={fieldState.error}
                                                    value={
                                                        field.value?.join(
                                                            ",",
                                                        ) ?? ""
                                                    }
                                                    onChange={(e) => {
                                                        const inputValue =
                                                            e.target.value;
                                                        if (inputValue === "") {
                                                            field.onChange([]);
                                                            return;
                                                        }
                                                        field.onChange(
                                                            inputValue
                                                                .split(/,\s*/)
                                                                .map((d) =>
                                                                    d.trim(),
                                                                ),
                                                        );
                                                    }}
                                                />
                                            </FormControl.Input>
                                            <FormControl.Error>
                                                {
                                                    errors.autoJoinConfig
                                                        ?.domains?.message
                                                }
                                            </FormControl.Error>
                                            <FormControl.Helper>
                                                Separate domains with commas.
                                                Only your own domain is
                                                accepted.
                                            </FormControl.Helper>
                                        </FormControl.Root>
                                    )}
                                />
                            )}
                        </SettingsRow>
                    </SettingsGroup>

                    <SettingsGroup
                        title="Review commands"
                        description={
                            <>
                                Anyone with write access to a repository can
                                start these reviews from a PR comment. Turning
                                one off blocks only the command: automatic
                                reviews keep the mode set in Routing.
                            </>
                        }>
                        {!props.reviewCommandModes && (
                            <p
                                role="alert"
                                className="text-danger px-5 py-4 text-sm">
                                These settings could not be loaded. Reload the
                                page to try again.
                            </p>
                        )}
                        {(
                            [
                                ["heavyBlocked", "Heavy", "--heavy"],
                                ["ultraBlocked", "Ultra", "--ultra"],
                            ] as const
                        ).map(([key, mode, flag]) => (
                            <Controller
                                key={key}
                                name={`reviewCommandModes.${key}`}
                                control={control}
                                render={({ field }) => (
                                    <SettingsRow
                                        title={`${mode} review`}
                                        description={
                                            <code className="text-text-secondary text-xs">
                                                @kody review {flag}
                                            </code>
                                        }
                                        htmlFor={field.name}
                                        control={
                                            // On means the command is
                                            // allowed; the stored value is
                                            // whether it is blocked.
                                            <Switch
                                                id={field.name}
                                                aria-label={`Allow ${mode} review by command`}
                                                disabled={
                                                    !props.reviewCommandModes
                                                }
                                                checked={!field.value}
                                                onCheckedChange={(allowed) =>
                                                    field.onChange(!allowed)
                                                }
                                            />
                                        }
                                    />
                                )}
                            />
                        ))}
                    </SettingsGroup>

                    <FixedEgressIpCard
                        initialSetting={props.fixedEgressIp}
                        loadFailed={props.fixedEgressIpLoadFailed}
                    />
                </Page.Content>
            </form>
        </Page.Root>
    );
};

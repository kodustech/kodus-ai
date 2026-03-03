"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
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
import {
    OrganizationParametersAutoJoinConfig,
    OrganizationParametersConfigKey,
    Timezone,
} from "@services/parameters/types";
import { Save } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { publicDomainsSet } from "src/core/utils/email";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";
import { z } from "zod";

const DEFAULT_MAX_FILES = 500;

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
            maxFiles: z.number().min(1).max(10000),
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
    maxFiles: number;
    isByokEnabled: boolean;
}) => {
    const router = useRouter();
    const userDomain = props.email.split("@")[1];

    const form = useForm<SettingsFormData>({
        mode: "onChange",
        resolver: zodResolver(createSettingsSchema(userDomain)),
        defaultValues: {
            timezone: props.timezone,
            autoJoinConfig: props.autoJoinConfig,
            maxFiles: props.maxFiles,
        },
    });

    const {
        control,
        handleSubmit,
        formState: { errors, isDirty, isValid },
    } = form;

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

                if (data.maxFiles !== props.maxFiles) {
                    promises.push(
                        createOrUpdateOrganizationParameter(
                            OrganizationParametersConfigKey.CODE_REVIEW_MAX_FILES,
                            data.maxFiles,
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
            <form onSubmit={handleSubmit(saveSettings)}>
                <Page.Header>
                    <Page.Title>General settings</Page.Title>
                    <Page.HeaderActions>
                        <Button
                            type="submit"
                            size="md"
                            variant="primary"
                            leftIcon={<Save />}
                            disabled={
                                !isDirty || !isValid || isLoadingSubmitButton
                            }
                            loading={isLoadingSubmitButton}>
                            Save settings
                        </Button>
                    </Page.HeaderActions>
                </Page.Header>

                <Page.Content className="flex flex-col gap-8">
                    <Controller
                        name="timezone"
                        control={control}
                        render={({ field }) => (
                            <FormControl.Root>
                                <FormControl.Label htmlFor="timezone">
                                    Timezone
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Select
                                        value={field.value}
                                        onValueChange={field.onChange}>
                                        <SelectTrigger
                                            id="timezone"
                                            className="w-72">
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
                                </FormControl.Input>
                            </FormControl.Root>
                        )}
                    />

                    <Card color="lv1" className="w-md">
                        <CardHeader>
                            <FormControl.Root className="flex flex-col">
                                <FormControl.Label className="mb-0 text-base font-bold">
                                    Auto Join
                                </FormControl.Label>
                                <FormControl.Helper className="mt-0 mb-5">
                                    Allow users with matching email domains to
                                    automatically join.
                                </FormControl.Helper>

                                <Controller
                                    name="autoJoinConfig.enabled"
                                    control={control}
                                    render={({ field }) => (
                                        <div className="flex items-center gap-3">
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
                                            <Label
                                                htmlFor={field.name}
                                                className="text-sm font-medium">
                                                Enable Auto Join
                                            </Label>
                                        </div>
                                    )}
                                />

                                <Controller
                                    name="autoJoinConfig.domains"
                                    control={control}
                                    render={({ field, fieldState }) => {
                                        const autoJoinEnabled = form.watch(
                                            "autoJoinConfig.enabled",
                                        );
                                        return (
                                            <>
                                                <FormControl.Input>
                                                    <Input
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

                                                            if (
                                                                inputValue ===
                                                                ""
                                                            ) {
                                                                field.onChange(
                                                                    [],
                                                                );
                                                                return;
                                                            }

                                                            const domains =
                                                                e.target.value
                                                                    .split(
                                                                        /,\s*/,
                                                                    )
                                                                    .map((d) =>
                                                                        d.trim(),
                                                                    );
                                                            field.onChange(
                                                                domains,
                                                            );
                                                        }}
                                                        disabled={
                                                            !autoJoinEnabled
                                                        }
                                                        className="mt-3"
                                                    />
                                                </FormControl.Input>
                                                <FormControl.Error>
                                                    {
                                                        errors.autoJoinConfig
                                                            ?.domains?.message
                                                    }
                                                </FormControl.Error>
                                                <FormControl.Helper>
                                                    Enter domains separated by
                                                    commas.
                                                </FormControl.Helper>
                                            </>
                                        );
                                    }}
                                />
                            </FormControl.Root>
                        </CardHeader>
                    </Card>

                    <Card color="lv1" className="w-md">
                        <CardHeader>
                            <FormControl.Root className="flex flex-col">
                                <FormControl.Label className="mb-0 text-base font-bold">
                                    Max Files per Review
                                </FormControl.Label>
                                <FormControl.Helper className="mt-0 mb-5">
                                    Maximum number of files to analyze per code
                                    review. Default is 500.
                                </FormControl.Helper>

                                <Controller
                                    name="maxFiles"
                                    control={control}
                                    render={({ field, fieldState }) => (
                                        <>
                                            <FormControl.Input>
                                                <Input
                                                    type="number"
                                                    placeholder={`${DEFAULT_MAX_FILES}`}
                                                    error={fieldState.error}
                                                    value={field.value}
                                                    onChange={(e) => {
                                                        const value = parseInt(
                                                            e.target.value,
                                                            10,
                                                        );
                                                        if (!isNaN(value)) {
                                                            field.onChange(
                                                                value,
                                                            );
                                                        } else if (
                                                            e.target.value ===
                                                            ""
                                                        ) {
                                                            field.onChange(
                                                                DEFAULT_MAX_FILES,
                                                            );
                                                        }
                                                    }}
                                                    disabled={
                                                        !props.isByokEnabled
                                                    }
                                                    className="mt-3 w-40"
                                                />
                                            </FormControl.Input>
                                            <FormControl.Error>
                                                {fieldState.error?.message}
                                            </FormControl.Error>
                                            {!props.isByokEnabled && (
                                                <FormControl.Helper className="mt-2">
                                                    This setting is only
                                                    configurable when{" "}
                                                    <Link
                                                        href="/organization/byok"
                                                        className="text-primary-light hover:underline">
                                                        BYOK mode
                                                    </Link>{" "}
                                                    is enabled.{" "}
                                                    <Link
                                                        href="https://docs.kodus.io/how_to_use/en/byok#byok-bring-your-own-key"
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-primary-light hover:underline">
                                                        Learn more
                                                    </Link>
                                                    .
                                                </FormControl.Helper>
                                            )}
                                        </>
                                    )}
                                />
                            </FormControl.Root>
                        </CardHeader>
                    </Card>
                </Page.Content>
            </form>
        </Page.Root>
    );
};

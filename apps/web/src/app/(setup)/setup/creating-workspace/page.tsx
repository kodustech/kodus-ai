"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { Collapsible, CollapsibleContent } from "@components/ui/collapsible";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { PhoneInput } from "@components/ui/phone-input";
import { Switch } from "@components/ui/switch";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffectOnce } from "@hooks/use-effect-once";
import { createOrUpdateOrganizationParameter } from "@services/organizationParameters/fetch";
import { useUpdateOrganizationInfos } from "@services/organizations/hooks";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import { ArrowRight } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { isValidPhoneNumber } from "react-phone-number-input";
import { useAuth } from "src/core/providers/auth.provider";
import { publicDomainsSet } from "src/core/utils/email";
import { useOrganizationContext } from "src/features/organization/_providers/organization-context";
import { z } from "zod";

import { StepIndicators } from "../_components/step-indicators";
import { useGoToStep } from "../_hooks/use-goto-step";

const createFormSchema = (userDomain: string) =>
    z
        .object({
            organizationName: z.string().min(1, {
                error: "What's your organization's name?",
            }),
            phone: z
                .string()
                .refine(isValidPhoneNumber, {
                    error: "Invalid phone number",
                })
                .or(z.literal(""))
                .optional(),
            autoJoin: z.boolean().optional(),
            autoJoinDomains: z
                .array(
                    z.string().refine(
                        (value) => {
                            if (!value) return true;
                            return /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value);
                        },
                        {
                            error: "Invalid domain format",
                        },
                    ),
                )
                .optional(),
        })
        .superRefine((data, ctx) => {
            if (data.autoJoin) {
                const domains = data.autoJoinDomains ?? [];
                const validDomains = domains.filter((d) => d);

                if (validDomains.length === 0) {
                    ctx.addIssue({
                        code: "custom",
                        message:
                            "At least one domain is required when auto-join is enabled.",
                        path: ["autoJoinDomains"],
                    });
                    return;
                }

                const lowerCaseDomains = domains.map((d) => d.toLowerCase());
                const isPublicDomain = lowerCaseDomains.some((d) =>
                    publicDomainsSet.has(d),
                );

                if (isPublicDomain) {
                    ctx.addIssue({
                        code: "custom",
                        message:
                            "Public email domains like gmail.com are not allowed.",
                        path: ["autoJoinDomains"],
                    });
                }

                const hasMismatchedDomain = validDomains.some(
                    (domain) => domain !== userDomain,
                );
                if (hasMismatchedDomain) {
                    ctx.addIssue({
                        code: "custom",
                        message: "You can only add your own domain.",
                        path: ["autoJoinDomains"],
                    });
                }
            }
        });

export default function App() {
    useGoToStep("/setup/marketing-survey");

    const router = useRouter();
    const { organizationName } = useOrganizationContext();
    const { mutateAsync } = useUpdateOrganizationInfos();
    const { email } = useAuth();

    const domain = email?.split("@")[1] || "";
    const isUserDomainPublic = publicDomainsSet.has(domain.toLowerCase());

    const formSchema = createFormSchema(domain);
    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        mode: "all",
        defaultValues: {
            phone: "",
            organizationName,
            autoJoin: !isUserDomainPublic,
            autoJoinDomains: isUserDomainPublic ? [] : [domain],
        },
    });

    const { trigger } = form;

    // Trigger validation on mount to validate default values
    useEffectOnce(() => {
        trigger();
    });

    const onSubmit = form.handleSubmit(async (data) => {
        await mutateAsync({
            name: data.organizationName,
            phone: data.phone,
        });

        const uniqueDomains = data.autoJoin
            ? [...new Set(data.autoJoinDomains?.filter((d) => d) ?? [])]
            : [];

        await createOrUpdateOrganizationParameter(
            OrganizationParametersConfigKey.AUTO_JOIN_CONFIG,
            {
                enabled: data.autoJoin,
                domains: uniqueDomains,
            },
        );

        router.push("/setup/marketing-survey");
    });

    const { isSubmitting, isValid } = form.formState;

    const autoJoinEnabled = form.watch("autoJoin");

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-row p-6">
            <div className="bg-card-lv1 flex flex-10 flex-col justify-center gap-10 rounded-3xl p-12">
                <div className="flex-1 overflow-hidden rounded-3xl">
                    <video
                        loop
                        muted
                        autoPlay
                        playsInline
                        disablePictureInPicture
                        className="h-full w-full object-contain"
                        src="/assets/videos/setup/learn-with-your-context.webm"
                    />
                </div>
            </div>

            <div className="flex flex-14 flex-col justify-center gap-20 p-10">
                <div className="flex flex-col items-center gap-10">
                    <div className="flex max-w-96 flex-col gap-6">
                        <StepIndicators.Auto />

                        <div className="flex flex-col gap-2">
                            <Heading variant="h2">
                                Let's create a Workspace
                            </Heading>

                            <p className="text-text-secondary text-sm">
                                Tell us about your team to customize Kody for
                                your workflows.
                            </p>
                        </div>

                        <Controller
                            name="organizationName"
                            control={form.control}
                            render={({ field, fieldState, formState }) => (
                                <FormControl.Root>
                                    <FormControl.Label htmlFor={field.name}>
                                        Organization Name
                                    </FormControl.Label>

                                    <FormControl.Input>
                                        <Input
                                            {...field}
                                            id={field.name}
                                            type="text"
                                            maxLength={100}
                                            placeholder="Enter the organization you work for"
                                            error={fieldState.error}
                                            autoCapitalize="none"
                                            autoCorrect="off"
                                            disabled={
                                                formState.isSubmitting ||
                                                formState.isLoading ||
                                                field.disabled
                                            }
                                        />
                                    </FormControl.Input>

                                    <FormControl.Error>
                                        {fieldState.error?.message}
                                    </FormControl.Error>
                                </FormControl.Root>
                            )}
                        />
                        <Controller
                            name="phone"
                            control={form.control}
                            render={({ field, fieldState, formState }) => (
                                <FormControl.Root>
                                    <FormControl.Label htmlFor={field.name}>
                                        Phone{" "}
                                        <small className="text-text-secondary">
                                            (optional)
                                        </small>
                                    </FormControl.Label>

                                    <FormControl.Input>
                                        <PhoneInput
                                            {...field}
                                            id={field.name}
                                            placeholder="Add a phone number for faster support"
                                            error={fieldState.error}
                                            autoCapitalize="none"
                                            autoCorrect="off"
                                            disabled={
                                                formState.isSubmitting ||
                                                formState.isLoading ||
                                                field.disabled
                                            }
                                        />
                                    </FormControl.Input>

                                    <FormControl.Error>
                                        {fieldState.error?.message}
                                    </FormControl.Error>

                                    <FormControl.Helper>
                                        Use country code or select a country
                                        before typing
                                    </FormControl.Helper>
                                </FormControl.Root>
                            )}
                        />

                        <Card color="lv1" className="overflow-visible">
                            <Collapsible open={autoJoinEnabled}>
                                <Controller
                                    name="autoJoin"
                                    control={form.control}
                                    render={({ field }) => (
                                        <Button
                                            size="md"
                                            variant="helper"
                                            className="p-0"
                                            onClick={() =>
                                                field.onChange(!field.value)
                                            }>
                                            <CardHeader className="flex flex-row gap-10">
                                                <div className="flex flex-col">
                                                    <FormControl.Label className="mb-0">
                                                        Enable Auto Join
                                                    </FormControl.Label>

                                                    <FormControl.Helper className="mt-0">
                                                        Allow anyone with an
                                                        approved email domain to
                                                        join.
                                                    </FormControl.Helper>
                                                </div>

                                                <Switch
                                                    decorative
                                                    checked={field.value}
                                                />
                                            </CardHeader>
                                        </Button>
                                    )}
                                />

                                <CollapsibleContent className="pb-0">
                                    <CardHeader className="pt-4">
                                        <Controller
                                            name="autoJoinDomains"
                                            control={form.control}
                                            render={({
                                                field,
                                                fieldState,
                                                formState,
                                            }) => (
                                                <FormControl.Root>
                                                    <FormControl.Label
                                                        htmlFor={field.name}>
                                                        Approved Domains
                                                    </FormControl.Label>
                                                    <FormControl.Input>
                                                        <Input
                                                            {...field}
                                                            id={field.name}
                                                            value={
                                                                field.value?.join(
                                                                    ",",
                                                                ) ?? ""
                                                            }
                                                            onChange={(e) => {
                                                                const inputValue =
                                                                    e.target
                                                                        .value;

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
                                                                        .map(
                                                                            (
                                                                                d,
                                                                            ) =>
                                                                                d.trim(),
                                                                        );
                                                                field.onChange(
                                                                    domains,
                                                                );
                                                            }}
                                                            placeholder="e.g., yourcompany.com"
                                                            error={
                                                                fieldState.error
                                                            }
                                                            disabled={
                                                                formState.isSubmitting
                                                            }
                                                        />
                                                    </FormControl.Input>
                                                    <FormControl.Helper className="mt-1">
                                                        Separate multiple
                                                        domains with a comma.
                                                    </FormControl.Helper>{" "}
                                                    <FormControl.Error>
                                                        {
                                                            fieldState.error
                                                                ?.message
                                                        }
                                                    </FormControl.Error>
                                                </FormControl.Root>
                                            )}
                                        />
                                    </CardHeader>
                                </CollapsibleContent>
                            </Collapsible>
                        </Card>

                        <Button
                            size="lg"
                            variant="primary"
                            className="w-full"
                            rightIcon={<ArrowRight />}
                            disabled={!isValid}
                            onClick={onSubmit}
                            loading={isSubmitting}>
                            Next
                        </Button>

                        <Link
                            href="/setup/marketing-survey"
                            className="self-center text-sm">
                            Skip this step for now
                        </Link>
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import { Page } from "@components/ui/page";
import { Switch } from "@components/ui/switch";
import { Textarea } from "@components/ui/textarea";
import { toast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAsyncAction } from "@hooks/use-async-action";
import {
    confirmSSODomainVerification,
    createOrUpdateSSOConfig,
    getSSOConnectionTestResult,
    getSSODomainVerificationStatus,
    startSSOConnectionTest,
} from "@services/ssoConfig/fetch";
import { AlertCircle, Save, Upload } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { useConfig } from "@providers/ConfigProvider";
import { useAuth } from "src/core/providers/auth.provider";
import { publicDomainsSet } from "src/core/utils/email";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";
import {
    buildSSOConfigFingerprint,
    normalizeDomains,
} from "src/lib/auth/sso-fingerprint";
import {
    SSOConfig,
    SSOConnectionTestSessionStatus,
    SSOConnectionTestStatus,
    SSODomainVerificationStatusItem,
    SSOProtocol,
} from "src/lib/auth/types";
import { z } from "zod";

import { DomainListManager } from "./_components/domain-list-manager";
import {
    fetchAndParseMetadata,
    parseMetadataFromFile,
} from "./_components/metadata";

const createSsoSchema = (userDomain: string) =>
    z
        .object({
            active: z.boolean().optional(),
            providerConfig: z.object({
                issuer: z.string().optional(),
                idpIssuer: z.string().default(""),
                entryPoint: z.string().default(""),
                cert: z.string().default(""),
                identifierFormat: z.string().optional(),
            }),
            domains: z.array(z.string()),
        })
        .superRefine((data, ctx) => {
            if (data.active) {
                const { providerConfig, domains } = data;

                if (!providerConfig.idpIssuer) {
                    ctx.addIssue({
                        code: "custom",
                        message: "Issuer is required",
                        path: ["providerConfig", "idpIssuer"],
                    });
                }

                if (!providerConfig.entryPoint) {
                    ctx.addIssue({
                        code: "custom",
                        message: "SSO URL is required",
                        path: ["providerConfig", "entryPoint"],
                    });
                } else {
                    try {
                        new URL(providerConfig.entryPoint);
                    } catch {
                        ctx.addIssue({
                            code: "custom",
                            message: "Must be a valid URL",
                            path: ["providerConfig", "entryPoint"],
                        });
                    }
                }

                if (!providerConfig.cert) {
                    ctx.addIssue({
                        code: "custom",
                        message: "Certificate is required",
                        path: ["providerConfig", "cert"],
                    });
                }

                const validDomains = domains.filter((d) => d);

                if (validDomains.length === 0) {
                    ctx.addIssue({
                        code: "custom",
                        message:
                            "At least one domain is required when SSO is enabled.",
                        path: ["domains"],
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
                        path: ["domains"],
                    });
                }
            }
        });

type SsoFormData = z.input<ReturnType<typeof createSsoSchema>>;

const SAML_EMAIL_IDENTIFIER_FORMAT =
    "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

interface SSOTestDraftStorage {
    active?: boolean;
    providerConfig?: SsoFormData["providerConfig"];
    domains?: string[];
}

const buildSSOTestDraftKey = (organizationId?: string) =>
    `sso-test-draft:${organizationId || "unknown"}`;

const toSamlProviderConfig = (config?: SsoFormData["providerConfig"]) => ({
    idpIssuer: config?.idpIssuer || "",
    entryPoint: config?.entryPoint || "",
    cert: config?.cert || "",
    identifierFormat: config?.identifierFormat,
    issuer: config?.issuer,
});

export const ClientSsoOrganizationSettingsPage = (props: {
    email: string;
    ssoConfig: SSOConfig<SSOProtocol.SAML>;
    uuid?: string;
}) => {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { organizationId } = useAuth();
    const { apiPublicUrl } = useConfig();
    const ssoTestSessionId = searchParams.get("ssoTestSessionId");
    const domainVerificationToken = searchParams.get("domainVerificationToken");
    const [metadataUrl, setMetadataUrl] = useState<string>("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [isTestingConnection, setIsTestingConnection] = useState(false);
    const [
        domainVerificationStatusByDomain,
        setDomainVerificationStatusByDomain,
    ] = useState<Record<string, SSODomainVerificationStatusItem>>({});
    const [latestSuccessfulTestSessionId, setLatestSuccessfulTestSessionId] =
        useState<string | null>(null);
    const [validatedFingerprint, setValidatedFingerprint] = useState<string>(
        props.ssoConfig.connectionTest?.status ===
            SSOConnectionTestStatus.SUCCESS
            ? props.ssoConfig.connectionTest.configFingerprint
            : "",
    );

    // SAML ACS URL displayed for the customer to paste into their IdP.
    // Must be (1) absolute — the IdP is an external system and can't
    // resolve relative paths — and (2) point at the API's public
    // origin directly, NOT at the same-origin /api/proxy/api/*
    // mount. The proxy is for browser fetches; SAML is a stateful
    // server-side flow that requires session cookies on the API's
    // own origin. See ssoLogin in lib/auth/fetchers.ts for the
    // matching reasoning on the initiation side.
    const callbackUrl =
        apiPublicUrl && organizationId
            ? `${apiPublicUrl.replace(/\/$/, "")}/auth/sso/saml/callback/${organizationId}`
            : "";

    const userDomain = props.email.split("@")[1];
    const form = useForm<SsoFormData>({
        mode: "onChange",
        resolver: zodResolver(createSsoSchema(userDomain)),
        defaultValues: {
            active: props.ssoConfig.active,
            providerConfig: {
                idpIssuer: props.ssoConfig.providerConfig?.idpIssuer || "",
                entryPoint: props.ssoConfig.providerConfig?.entryPoint || "",
                cert: props.ssoConfig.providerConfig?.cert || "",
                identifierFormat:
                    props.ssoConfig.providerConfig?.identifierFormat ||
                    SAML_EMAIL_IDENTIFIER_FORMAT,
                issuer:
                    props.ssoConfig.providerConfig.issuer ||
                    "kodus-orchestrator",
            },
            domains:
                props.ssoConfig.domains.length > 0
                    ? props.ssoConfig.domains
                    : [userDomain],
        },
    });

    const {
        control,
        handleSubmit,
        reset,
        setValue,
        watch,
        formState: { errors, isDirty, isValid },
    } = form;

    const isEnabled = watch("active");
    const watchedProviderConfig = watch("providerConfig");
    const watchedDomains = watch("domains");

    const currentFingerprint = useMemo(() => {
        return buildSSOConfigFingerprint({
            protocol: SSOProtocol.SAML,
            providerConfig: toSamlProviderConfig(watchedProviderConfig),
            domains: watchedDomains || [],
        });
    }, [watchedProviderConfig, watchedDomains]);

    const candidateDomains = useMemo(
        () => normalizeDomains(watchedDomains || []),
        [watchedDomains],
    );

    const persistedFingerprint = useMemo(() => {
        return buildSSOConfigFingerprint({
            protocol: SSOProtocol.SAML,
            providerConfig: toSamlProviderConfig(
                props.ssoConfig.providerConfig,
            ),
            domains:
                props.ssoConfig.domains.length > 0
                    ? props.ssoConfig.domains
                    : [userDomain],
        });
    }, [props.ssoConfig.domains, props.ssoConfig.providerConfig, userDomain]);

    const hasUnsavedChangesComparedToPersistedConfig =
        currentFingerprint !== persistedFingerprint ||
        Boolean(isEnabled) !== Boolean(props.ssoConfig.active);

    const needsConnectionRetest =
        Boolean(isEnabled) && currentFingerprint !== validatedFingerprint;

    const unverifiedDomains = useMemo(() => {
        return candidateDomains.filter(
            (domain) => !domainVerificationStatusByDomain[domain]?.verified,
        );
    }, [candidateDomains, domainVerificationStatusByDomain]);

    const needsDomainVerification =
        Boolean(isEnabled) && unverifiedDomains.length > 0;

    useEffect(() => {
        const entries =
            props.ssoConfig.domainVerification?.verifiedDomains?.map(
                (record) => [
                    record.domain,
                    {
                        domain: record.domain,
                        verified: true,
                        verifiedAt: record.verifiedAt,
                        verifiedByEmail: record.verifiedByEmail,
                    } satisfies SSODomainVerificationStatusItem,
                ],
            ) || [];

        setDomainVerificationStatusByDomain(Object.fromEntries(entries));
    }, [props.ssoConfig.domainVerification]);

    useEffect(() => {
        if (!organizationId) {
            return;
        }

        try {
            const draftRaw = window.localStorage.getItem(
                buildSSOTestDraftKey(organizationId),
            );

            if (!draftRaw) {
                return;
            }

            const parsedDraft = JSON.parse(draftRaw) as SSOTestDraftStorage;

            if (!parsedDraft || !parsedDraft.providerConfig) {
                return;
            }

            reset({
                active: parsedDraft.active,
                providerConfig: {
                    issuer: parsedDraft.providerConfig.issuer,
                    idpIssuer: parsedDraft.providerConfig.idpIssuer || "",
                    entryPoint: parsedDraft.providerConfig.entryPoint || "",
                    cert: parsedDraft.providerConfig.cert || "",
                    identifierFormat: SAML_EMAIL_IDENTIFIER_FORMAT,
                },
                domains: parsedDraft.domains || [userDomain],
            });
        } catch (error) {
            console.error("Failed to restore SSO test draft", error);
        }
    }, [organizationId, reset, userDomain]);

    useEffect(() => {
        if (!ssoTestSessionId) {
            return;
        }

        let ignore = false;

        const loadTestResult = async () => {
            try {
                const result =
                    await getSSOConnectionTestResult(ssoTestSessionId);

                if (ignore) {
                    return;
                }

                if (result.status === SSOConnectionTestSessionStatus.SUCCESS) {
                    setValidatedFingerprint(result.configFingerprint);
                    setLatestSuccessfulTestSessionId(result.sessionId);
                    toast({
                        title: "Connection verified",
                        description:
                            "SSO test succeeded. You can now save and enable SSO.",
                        variant: "success",
                    });
                } else if (
                    result.status === SSOConnectionTestSessionStatus.FAILED
                ) {
                    toast({
                        title: "SSO test failed",
                        description:
                            result.failureMessage ||
                            "Unable to validate the SSO connection with the current draft settings.",
                        variant: "danger",
                    });
                }
            } catch (error: any) {
                toast({
                    title: "Could not load test result",
                    description:
                        error?.response?.data?.message ||
                        "The SSO test session is no longer available. Run the test again.",
                    variant: "danger",
                });
            } finally {
                router.replace("/organization/sso");
            }
        };

        loadTestResult();

        return () => {
            ignore = true;
        };
    }, [router, ssoTestSessionId]);

    useEffect(() => {
        if (!domainVerificationToken) {
            return;
        }

        let ignore = false;

        const confirmToken = async () => {
            try {
                const result = await confirmSSODomainVerification(
                    domainVerificationToken,
                );

                if (ignore) {
                    return;
                }

                setDomainVerificationStatusByDomain((prev) => ({
                    ...prev,
                    [result.domain]: {
                        domain: result.domain,
                        verified: true,
                        verifiedAt: result.verifiedAt,
                        verifiedByEmail: result.verifiedByEmail,
                    },
                }));

                toast({
                    title: "Domain verified",
                    description: `${result.domain} was verified successfully.`,
                    variant: "success",
                });
            } catch (error: any) {
                toast({
                    title: "Domain verification failed",
                    description:
                        error?.response?.data?.message ||
                        "The verification link is invalid or expired.",
                    variant: "danger",
                });
            } finally {
                router.replace("/organization/sso");
            }
        };

        confirmToken();

        return () => {
            ignore = true;
        };
    }, [domainVerificationToken, router]);

    useEffect(() => {
        if (!candidateDomains.length) {
            return;
        }

        let ignore = false;

        const loadDomainVerificationStatus = async () => {
            try {
                const result =
                    await getSSODomainVerificationStatus(candidateDomains);

                if (ignore) {
                    return;
                }

                const map = Object.fromEntries(
                    result.map((item) => [item.domain, item]),
                );

                setDomainVerificationStatusByDomain((prev) => {
                    const next = { ...prev };

                    for (const [domain, status] of Object.entries(map)) {
                        const previousStatus = prev[domain];

                        if (previousStatus?.verified && !status.verified) {
                            // Keep persisted verified status when cache has no record.
                            continue;
                        }

                        next[domain] =
                            status as SSODomainVerificationStatusItem;
                    }

                    return next;
                });
            } catch (error) {
                console.error(
                    "Failed to load domain verification status",
                    error,
                );
            }
        };

        loadDomainVerificationStatus();

        return () => {
            ignore = true;
        };
    }, [candidateDomains]);

    const [saveSettings, { loading: isLoadingSubmitButton }] = useAsyncAction(
        async (data: SsoFormData) => {
            try {
                const canAttachTestSession =
                    currentFingerprint === validatedFingerprint &&
                    !!latestSuccessfulTestSessionId;

                const updated = await createOrUpdateSSOConfig({
                    protocol: SSOProtocol.SAML,
                    providerConfig: toSamlProviderConfig(data.providerConfig),
                    active: data.active,
                    uuid: props.uuid,
                    domains: data.domains,
                    testSessionId: canAttachTestSession
                        ? latestSuccessfulTestSessionId || undefined
                        : undefined,
                });

                if (
                    updated.connectionTest?.status ===
                    SSOConnectionTestStatus.SUCCESS
                ) {
                    setValidatedFingerprint(
                        updated.connectionTest.configFingerprint,
                    );
                }

                setLatestSuccessfulTestSessionId(null);

                if (organizationId) {
                    window.localStorage.removeItem(
                        buildSSOTestDraftKey(organizationId),
                    );
                }

                await revalidateServerSidePath("/organization/sso");
                router.refresh();
                form.reset(data);
                toast({
                    description: "SSO settings saved",
                    variant: "success",
                });
            } catch (error: any) {
                const code =
                    error?.response?.data?.code ||
                    error?.response?.data?.error?.code;
                const message =
                    error?.response?.data?.message ||
                    error?.message ||
                    "Unable to save SSO settings";

                toast({
                    title: "Error",
                    description:
                        code === "SSO_TEST_REQUIRED"
                            ? "Run a successful SSO connection test before enabling SSO."
                            : message,
                    variant: "danger",
                });
                console.error(error);
            }
        },
    );

    const handleConnectionTest = async () => {
        const isFormValid = await form.trigger();

        if (!isFormValid) {
            toast({
                title: "Review SSO settings",
                description:
                    "Fix validation errors before running the connection test.",
                variant: "danger",
            });
            return;
        }

        const values = form.getValues();
        setIsTestingConnection(true);

        try {
            if (organizationId) {
                window.localStorage.setItem(
                    buildSSOTestDraftKey(organizationId),
                    JSON.stringify({
                        active: values.active,
                        providerConfig: values.providerConfig,
                        domains: values.domains,
                    } satisfies SSOTestDraftStorage),
                );
            }

            const result = await startSSOConnectionTest({
                protocol: SSOProtocol.SAML,
                providerConfig: toSamlProviderConfig(values.providerConfig),
                domains: values.domains,
            });

            if (!result.redirectUrl) {
                throw new Error("No redirect URL provided by server");
            }

            router.push(result.redirectUrl);
        } catch (error: any) {
            console.error(error);
            setIsTestingConnection(false);
            toast({
                title: "Could not start SSO test",
                description:
                    error?.response?.data?.message ||
                    "Please verify the draft settings and try again.",
                variant: "danger",
            });
        }
    };

    const handleMetadataFetch = async () => {
        if (!metadataUrl) return;

        try {
            const { idpIssuer, entryPoint, cert, success, error } =
                await fetchAndParseMetadata(metadataUrl);

            if (!success) {
                throw new Error(error);
            }

            setValue("providerConfig.idpIssuer", idpIssuer);
            setValue("providerConfig.entryPoint", entryPoint);
            setValue("providerConfig.cert", cert);
            form.trigger();
        } catch (error) {
            toast({
                title: "Error",
                description:
                    "Failed to fetch metadata. Please check the URL and try again.",
                variant: "danger",
            });
        }
    };

    const handleFileUpload = async (
        event: React.ChangeEvent<HTMLInputElement>,
    ) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsUploading(true);

        try {
            const fileContent = await file.text();
            const { idpIssuer, entryPoint, cert, success, error } =
                await parseMetadataFromFile(fileContent);

            if (!success) {
                throw new Error(error);
            }

            setValue("providerConfig.idpIssuer", idpIssuer);
            setValue("providerConfig.entryPoint", entryPoint);
            setValue("providerConfig.cert", cert);
            form.trigger();

            toast({
                description: "Metadata uploaded successfully",
                variant: "success",
            });
        } catch (error) {
            console.error("File upload error:", error);
            toast({
                title: "Error",
                description:
                    "Failed to parse metadata file. Please make sure it's a valid SAML metadata XML file.",
                variant: "danger",
            });
        } finally {
            setIsUploading(false);
            // Reset the file input
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
        }
    };

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const hasDomainMismatch =
        Boolean(isEnabled) &&
        !!userDomain &&
        (watchedDomains
            ?.filter((d) => d)
            .some((d) => d.toLowerCase() !== userDomain.toLowerCase()) ??
            false);

    return (
        <Page.Root>
            <form onSubmit={handleSubmit(saveSettings)}>
                <Page.Header>
                    <Page.Title>SSO Settings</Page.Title>
                    <Page.HeaderActions>
                        <Button
                            type="button"
                            size="md"
                            variant="secondary"
                            onClick={handleConnectionTest}
                            loading={isTestingConnection}
                            disabled={
                                isLoadingSubmitButton || isTestingConnection
                            }>
                            Test connection
                        </Button>
                        <Button
                            type="submit"
                            size="md"
                            variant="primary"
                            leftIcon={<Save />}
                            disabled={
                                (!isDirty &&
                                    !hasUnsavedChangesComparedToPersistedConfig) ||
                                !isValid ||
                                isLoadingSubmitButton ||
                                (isEnabled && needsConnectionRetest) ||
                                needsDomainVerification
                            }
                            loading={isLoadingSubmitButton}>
                            Save settings
                        </Button>
                    </Page.HeaderActions>
                </Page.Header>

                <Page.Content className="flex flex-col gap-8">
                    <Card color="lv1" className="w-full max-w-3xl">
                        <CardHeader className="space-y-6">
                            <div className="space-y-1">
                                <h3 className="text-lg font-semibold">
                                    SAML SSO Configuration
                                </h3>
                                <p className="text-sm text-gray-500">
                                    Configure SAML Single Sign-On for your
                                    organization
                                </p>
                            </div>

                            <div className="space-y-6">
                                <Controller
                                    name="active"
                                    control={control}
                                    render={({ field }) => (
                                        <div className="flex items-center space-x-3">
                                            <Switch
                                                id="enable-sso"
                                                checked={field.value}
                                                onCheckedChange={field.onChange}
                                            />
                                            <Label
                                                htmlFor="enable-sso"
                                                className="text-sm font-medium">
                                                Enable SAML SSO
                                            </Label>
                                        </div>
                                    )}
                                />

                                {isEnabled && (
                                    <div className="space-y-6 border-t border-gray-200 pt-6">
                                        {needsConnectionRetest && (
                                            <Alert variant="warning">
                                                <AlertCircle />
                                                <AlertDescription>
                                                    Run "Test connection" and
                                                    complete a successful IdP
                                                    login before saving enabled
                                                    SSO settings.
                                                </AlertDescription>
                                            </Alert>
                                        )}

                                        {needsDomainVerification && (
                                            <Alert variant="warning">
                                                <AlertCircle />
                                                <AlertDescription>
                                                    Verify each domain before
                                                    enabling SSO. Pending
                                                    domains:{" "}
                                                    {unverifiedDomains.join(
                                                        ", ",
                                                    )}
                                                </AlertDescription>
                                            </Alert>
                                        )}

                                        <div className="grid grid-cols-1 gap-6 sm:grid-cols-1">
                                            <div className="space-y-4">
                                                <FormControl.Root>
                                                    <FormControl.Label>
                                                        Metadata URL (optional)
                                                    </FormControl.Label>
                                                    <div className="flex space-x-2">
                                                        <Input
                                                            placeholder="https://idp.example.com/metadata.xml"
                                                            value={metadataUrl}
                                                            onChange={(e) =>
                                                                setMetadataUrl(
                                                                    e.target
                                                                        .value,
                                                                )
                                                            }
                                                            className="flex-1"
                                                        />
                                                        <Button
                                                            type="button"
                                                            variant="primary"
                                                            size="md"
                                                            onClick={
                                                                handleMetadataFetch
                                                            }
                                                            disabled={
                                                                !metadataUrl ||
                                                                isUploading
                                                            }>
                                                            Fetch
                                                        </Button>
                                                    </div>
                                                </FormControl.Root>

                                                <div className="relative">
                                                    <div className="absolute inset-0 flex items-center">
                                                        <div className="w-full border-t border-gray-200"></div>
                                                    </div>
                                                    <div className="relative flex justify-center text-sm">
                                                        <span className="bg-card-lv1 px-2 text-gray-500">
                                                            or
                                                        </span>
                                                    </div>
                                                </div>

                                                <div>
                                                    <Button
                                                        type="button"
                                                        variant="secondary"
                                                        size="md"
                                                        onClick={
                                                            handleUploadClick
                                                        }
                                                        disabled={isUploading}
                                                        className="w-full">
                                                        <Upload className="mr-2 h-4 w-4" />
                                                        {isUploading
                                                            ? "Uploading..."
                                                            : "Upload Metadata XML File"}
                                                    </Button>
                                                    <input
                                                        type="file"
                                                        ref={fileInputRef}
                                                        onChange={
                                                            handleFileUpload
                                                        }
                                                        accept=".xml"
                                                        className="hidden"
                                                    />
                                                </div>

                                                <FormControl.Helper>
                                                    Provide a metadata URL or
                                                    upload an XML file to
                                                    auto-fill the fields below
                                                </FormControl.Helper>

                                                <div className="pt-2">
                                                    <FormControl.Root>
                                                        <FormControl.Label>
                                                            Callback URL
                                                        </FormControl.Label>
                                                        <div className="flex items-center space-x-2">
                                                            <Input
                                                                value={
                                                                    callbackUrl
                                                                }
                                                                readOnly
                                                                className="flex-1 font-mono text-sm"
                                                                onClick={() => {
                                                                    navigator.clipboard.writeText(
                                                                        callbackUrl,
                                                                    );
                                                                    toast({
                                                                        title: "Copied",
                                                                        description:
                                                                            "Callback URL copied to clipboard",
                                                                        variant:
                                                                            "success",
                                                                    });
                                                                }}
                                                            />
                                                            <Button
                                                                type="button"
                                                                variant="secondary"
                                                                size="md"
                                                                onClick={() => {
                                                                    navigator.clipboard.writeText(
                                                                        callbackUrl,
                                                                    );
                                                                    toast({
                                                                        title: "Copied",
                                                                        variant:
                                                                            "success",
                                                                        description:
                                                                            "Callback URL copied to clipboard",
                                                                    });
                                                                }}>
                                                                Copy
                                                            </Button>
                                                        </div>
                                                        <FormControl.Helper>
                                                            Provide this URL to
                                                            your identity
                                                            provider
                                                        </FormControl.Helper>
                                                    </FormControl.Root>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                            <FormControl.Root>
                                                <FormControl.Label>
                                                    Service Provider Entity ID
                                                </FormControl.Label>
                                                <Controller
                                                    name="providerConfig.issuer"
                                                    control={control}
                                                    render={({ field }) => (
                                                        <Input
                                                            {...field}
                                                            value={
                                                                field.value ||
                                                                "kodus-orchestrator"
                                                            }
                                                            placeholder="kodus-orchestrator"
                                                        />
                                                    )}
                                                />
                                                <FormControl.Helper>
                                                    Entity ID for this service
                                                    provider (default:
                                                    kodus-orchestrator)
                                                </FormControl.Helper>
                                            </FormControl.Root>

                                            <FormControl.Root>
                                                <FormControl.Label>
                                                    IDP Issuer
                                                </FormControl.Label>
                                                <Controller
                                                    name="providerConfig.idpIssuer"
                                                    control={control}
                                                    render={({ field }) => (
                                                        <Input
                                                            {...field}
                                                            placeholder="urn:example:sp"
                                                        />
                                                    )}
                                                />
                                                <FormControl.Error>
                                                    {
                                                        errors.providerConfig
                                                            ?.idpIssuer?.message
                                                    }
                                                </FormControl.Error>
                                                <FormControl.Helper>
                                                    Entity ID of your identity
                                                    provider
                                                </FormControl.Helper>
                                            </FormControl.Root>
                                        </div>

                                        <div className="grid grid-cols-1 gap-6 sm:grid-cols-1">
                                            <FormControl.Root>
                                                <FormControl.Label>
                                                    SSO URL
                                                </FormControl.Label>
                                                <Controller
                                                    name="providerConfig.entryPoint"
                                                    control={control}
                                                    render={({ field }) => (
                                                        <Input
                                                            {...field}
                                                            placeholder="https://idp.example.com/sso"
                                                        />
                                                    )}
                                                />
                                                <FormControl.Error>
                                                    {
                                                        errors.providerConfig
                                                            ?.entryPoint
                                                            ?.message
                                                    }
                                                </FormControl.Error>
                                                <FormControl.Helper>
                                                    Your IdP's SSO endpoint
                                                </FormControl.Helper>
                                            </FormControl.Root>
                                        </div>

                                        <div className="grid grid-cols-1 gap-6">
                                            <FormControl.Root>
                                                <FormControl.Label>
                                                    X.509 Certificate
                                                </FormControl.Label>
                                                <Controller
                                                    name="providerConfig.cert"
                                                    control={control}
                                                    render={({ field }) => (
                                                        <Textarea
                                                            {...field}
                                                            placeholder="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
                                                            rows={6}
                                                            className="font-mono text-sm"
                                                        />
                                                    )}
                                                />
                                                <FormControl.Error>
                                                    {
                                                        errors.providerConfig
                                                            ?.cert?.message
                                                    }
                                                </FormControl.Error>
                                                <FormControl.Helper>
                                                    The public certificate from
                                                    your IdP in PEM format
                                                </FormControl.Helper>
                                            </FormControl.Root>
                                        </div>

                                        <div className="grid grid-cols-1 gap-6 sm:grid-cols-1">
                                            <FormControl.Root>
                                                <FormControl.Label>
                                                    Identifier Format
                                                </FormControl.Label>
                                                <input
                                                    type="hidden"
                                                    {...form.register(
                                                        "providerConfig.identifierFormat",
                                                    )}
                                                />
                                                <div className="bg-muted text-muted-foreground flex h-10 items-center rounded-md border px-3 py-2 text-sm">
                                                    {
                                                        SAML_EMAIL_IDENTIFIER_FORMAT
                                                    }
                                                </div>
                                                <FormControl.Helper>
                                                    The identifier format is
                                                    fixed to email address
                                                    format. This cannot be
                                                    changed. Ensure your IdP is
                                                    configured to use this
                                                    format.
                                                </FormControl.Helper>
                                            </FormControl.Root>
                                        </div>

                                        <FormControl.Root>
                                            <FormControl.Label>
                                                Allowed Domains
                                            </FormControl.Label>
                                            <Controller
                                                name="domains"
                                                control={control}
                                                render={({
                                                    field,
                                                    fieldState,
                                                }) => (
                                                    <>
                                                        <DomainListManager
                                                            domains={
                                                                field.value ||
                                                                []
                                                            }
                                                            onDomainsChange={
                                                                field.onChange
                                                            }
                                                            statusByDomain={
                                                                domainVerificationStatusByDomain
                                                            }
                                                            errorMessage={
                                                                fieldState.error
                                                                    ?.message
                                                            }
                                                            hasDomainMismatch={
                                                                hasDomainMismatch
                                                            }
                                                            userDomain={
                                                                userDomain
                                                            }
                                                            onAutoVerified={(
                                                                record,
                                                            ) =>
                                                                setDomainVerificationStatusByDomain(
                                                                    (prev) => ({
                                                                        ...prev,
                                                                        [record.domain]:
                                                                        {
                                                                            domain: record.domain,
                                                                            verified:
                                                                                true,
                                                                            verifiedAt:
                                                                                record.verifiedAt,
                                                                            verifiedByEmail:
                                                                                record.contactEmail,
                                                                        },
                                                                    }),
                                                                )
                                                            }
                                                        />
                                                    </>
                                                )}
                                            />
                                        </FormControl.Root>
                                    </div>
                                )}
                            </div>
                        </CardHeader>
                    </Card>
                </Page.Content>
            </form>
        </Page.Root>
    );
};

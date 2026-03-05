"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Avatar, AvatarImage } from "@components/ui/avatar";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { MagicModalContext } from "@components/ui/magic-modal";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { useToast } from "@components/ui/toaster/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAsyncAction } from "@hooks/use-async-action";
import { TypedFetchError } from "@services/fetch";
import {
    createMCPCustomPlugin,
    getMCPPluginById,
    updateMCPCustomPlugin,
} from "@services/mcp-manager/fetch";
import {
    CUSTOM_MCP_AUTH_METHODS,
    CUSTOM_MCP_PROTOCOLS,
    CustomIntegrationErrorCode,
    CustomMCPAuthMethodType,
    CustomMCPProtocolType,
    IntegrationErrorCode,
    OAuthErrorCode,
} from "@services/mcp-manager/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { ImageOff, Trash2 } from "lucide-react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { AwaitedReturnType } from "src/core/types";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";
import z from "zod";

const baseSchema = z.object({
    name: z.string().trim().min(1, "Plugin Name is required"),
    description: z.string().optional(),
    baseUrl: z.url().trim().min(1, "URL is required"),
    protocol: z.enum(CUSTOM_MCP_PROTOCOLS),
    logoUrl: z.string().optional(),
    headers: z.array(
        z.object({
            key: z.string(),
            value: z.string(),
        }),
    ),
});

const authSchema = z.discriminatedUnion("authMethod", [
    z.object({ authMethod: z.literal(CUSTOM_MCP_AUTH_METHODS.NONE) }),
    z.object({
        authMethod: z.literal(CUSTOM_MCP_AUTH_METHODS.BEARER),
        bearerToken: z.string().trim().min(1, "Bearer Token is required"),
    }),
    z.object({
        authMethod: z.literal(CUSTOM_MCP_AUTH_METHODS.BASIC),
        basicUser: z.string().trim().min(1, "Username is required"),
        basicPassword: z.string().optional(),
    }),
    z.object({
        authMethod: z.literal(CUSTOM_MCP_AUTH_METHODS.API_KEY),
        apiKey: z.string().trim().min(1, "API Key is required"),
        apiKeyHeader: z.string().trim().min(1, "Header Name is required"),
    }),
    z
        .object({
            authMethod: z.literal(CUSTOM_MCP_AUTH_METHODS.OAUTH2),
            clientId: z.string().optional(),
            clientSecret: z.string().optional(),
            oauthScopes: z.array(z.string()).optional(),
            dynamicRegistration: z.boolean().optional(),
        })
        .refine((data) => data.dynamicRegistration || data.clientId, {
            message:
                "Client ID is required when dynamic registration is disabled",
            path: ["clientId"],
        }),
]);

const addCustomPluginSchema = z
    .intersection(baseSchema, authSchema)
    .superRefine((data, ctx) => {
        const existingKeys = new Set<string>();
        let hasDuplicates = false;

        data.headers.forEach((header, index) => {
            const key = header.key.trim().toLowerCase();
            if (!key) return;

            if (existingKeys.has(key)) {
                hasDuplicates = true;
                ctx.addIssue({
                    code: "custom",
                    message: "Key must be unique",
                    path: [`headers.${index}.key`],
                });
            }
            existingKeys.add(key);
        });

        if (hasDuplicates) {
            ctx.addIssue({
                code: "custom",
                message: "Header keys must be unique.",
                path: ["headers"],
            });
        }
    });

type AddCustomPluginFormValues = z.infer<typeof addCustomPluginSchema>;

const getEmptyDefaultValues = (): AddCustomPluginFormValues => ({
    name: "",
    description: "",
    baseUrl: "",
    protocol: CUSTOM_MCP_PROTOCOLS.HTTP,
    logoUrl: "",
    authMethod: CUSTOM_MCP_AUTH_METHODS.NONE,
    headers: [{ key: "", value: "" }],
    // @ts-expect-error Default values for discriminated union
    bearerToken: "",
    basicUser: "",
    basicPassword: "",
    apiKey: "",
    apiKeyHeader: "",
    clientId: "",
    clientSecret: "",
    oauthScopes: "",
    dynamicRegistration: false,
});

const convertApiDataToFormData = (
    data: AwaitedReturnType<typeof getMCPPluginById>,
): AddCustomPluginFormValues => {
    const formData: AddCustomPluginFormValues = {
        name: data.name || "",
        description: data.description || "",
        baseUrl: data.baseUrl || "",
        protocol:
            (data.protocol as CustomMCPProtocolType) ||
            CUSTOM_MCP_PROTOCOLS.HTTP,
        logoUrl: data.logo || "",
        authMethod:
            (data.authType as CustomMCPAuthMethodType) ||
            CUSTOM_MCP_AUTH_METHODS.NONE,
        headers: [],
        bearerToken: "",
        basicUser: "",
        basicPassword: "",
        apiKey: "",
        apiKeyHeader: "",
        clientId: "",
        clientSecret: "",
        oauthScopes: [],
        dynamicRegistration: false, // Default to false for existing plugins
    };

    if (data.headers && Object.entries(data.headers).length > 0) {
        for (const [key, value] of Object.entries(data.headers)) {
            formData.headers.push({ key, value });
        }
    }

    switch (formData.authMethod) {
        case CUSTOM_MCP_AUTH_METHODS.BEARER:
            formData.bearerToken = "";
            break;
        case CUSTOM_MCP_AUTH_METHODS.BASIC:
            formData.basicUser = data.basicUser || "";
            formData.basicPassword = "";
            break;
        case CUSTOM_MCP_AUTH_METHODS.API_KEY:
            formData.apiKey = "";
            formData.apiKeyHeader = data.apiKeyHeader || "";
            break;
        case CUSTOM_MCP_AUTH_METHODS.OAUTH2:
            formData.clientId = data.clientId || "";
            formData.clientSecret = "";
            formData.oauthScopes = data.oauthScopes || [];
            formData.dynamicRegistration = data.dynamicRegistration || false;
            break;
        case CUSTOM_MCP_AUTH_METHODS.NONE:
        default:
            break;
    }

    return formData;
};

const convertFormDataToApiPayload = (
    formData: AddCustomPluginFormValues,
): Parameters<typeof createMCPCustomPlugin>[0] => {
    const payload: Parameters<typeof createMCPCustomPlugin>[0] = {
        name: formData.name,
        description: formData.description || undefined,
        baseUrl: formData.baseUrl,
        authType: formData.authMethod,
        protocol: formData.protocol,
        logoUrl: formData.logoUrl || undefined,
    };

    // If using dynamic registration, ensure client credentials are not sent
    if (
        formData.authMethod === CUSTOM_MCP_AUTH_METHODS.OAUTH2 &&
        formData.dynamicRegistration
    ) {
        payload.clientId = "";
        payload.clientSecret = "";
        payload.oauthScopes = [];
    }

    const filteredHeaders = formData.headers.filter(
        (header) => header.key.trim() !== "",
    );
    if (filteredHeaders.length > 0) {
        payload.headers = filteredHeaders;
    }

    switch (formData.authMethod) {
        case CUSTOM_MCP_AUTH_METHODS.BEARER:
            payload.bearerToken = formData.bearerToken;
            break;
        case CUSTOM_MCP_AUTH_METHODS.BASIC:
            payload.basicUser = formData.basicUser;
            payload.basicPassword = formData.basicPassword;
            break;
        case CUSTOM_MCP_AUTH_METHODS.API_KEY:
            payload.apiKey = formData.apiKey;
            payload.apiKeyHeader = formData.apiKeyHeader;
            break;
        case CUSTOM_MCP_AUTH_METHODS.OAUTH2:
            payload.clientId = formData.clientId;
            payload.clientSecret = formData.clientSecret;
            payload.oauthScopes = formData.oauthScopes;
            payload.dynamicRegistration = formData.dynamicRegistration;
            break;
        case CUSTOM_MCP_AUTH_METHODS.NONE:
        default:
            break;
    }

    return payload;
};

type BackendErrorBody = {
    code?: string;
    message?: string;
    details?: Record<string, any>;
};

const getFriendlyErrorMessage = (
    error: unknown,
): { title: string; description: string } => {
    if (!TypedFetchError.isError(error)) {
        return {
            title: "Error",
            description:
                "Are the protocol, URL, and authorization details correct? Please check and try again.",
        };
    }

    const body = (error.body || {}) as BackendErrorBody;
    const code = body.code as IntegrationErrorCode | undefined;
    const details = body.details || {};

    // Custom integration validation errors
    if (code === IntegrationErrorCode.VALIDATION_ERROR) {
        const field = details.field as CustomIntegrationErrorCode | undefined;

        switch (field) {
            case CustomIntegrationErrorCode.CUSTOM_INTEGRATION_MISSING_FIELDS:
                return {
                    title: "Missing required fields",
                    description:
                        "Name, authorization type, and protocol are required for custom plugins.",
                };
            case CustomIntegrationErrorCode.CUSTOM_INTEGRATION_VALIDATION_FAILED: {
                const baseUrl = details.baseUrl as string | undefined;
                return {
                    title: "Could not validate plugin",
                    description: baseUrl
                        ? `We couldn't reach or validate the MCP server at ${baseUrl}. Check the URL, protocol, and auth settings, then try again.`
                        : "We couldn't validate this custom plugin. Check the URL, protocol, and auth settings, then try again.",
                };
            }
            case CustomIntegrationErrorCode.CUSTOM_INTEGRATION_EDIT_NOT_SUPPORTED:
                return {
                    title: "Editing not supported",
                    description:
                        "Editing this integration is only supported for custom plugins.",
                };
            case CustomIntegrationErrorCode.CUSTOM_INTEGRATION_DELETE_NOT_SUPPORTED:
                return {
                    title: "Delete not supported",
                    description:
                        "Deleting this integration is only supported for custom plugins.",
                };
            case CustomIntegrationErrorCode.CUSTOM_INTEGRATION_HAS_ACTIVE_CONNECTIONS:
                return {
                    title: "Plugin is still in use",
                    description:
                        "This plugin has active connections. Disconnect it from all workspaces before deleting it.",
                };
            default:
                return {
                    title: "Validation error",
                    description:
                        body.message ||
                        "There is a problem with this configuration. Please review the fields and try again.",
                };
        }
    }

    // OAuth-specific errors
    if (code === IntegrationErrorCode.OAUTH_ERROR) {
        const oauthErrorCode = details.oauthErrorCode as
            | OAuthErrorCode
            | undefined;
        switch (oauthErrorCode) {
            case OAuthErrorCode.OAUTH_CONFIG_MISSING_REDIRECT_URI:
                return {
                    title: "OAuth redirect not configured",
                    description:
                        "The server is missing the OAuth redirect URL configuration. Please contact your administrator.",
                };
            case OAuthErrorCode.OAUTH_DISCOVERY_MISSING_AUTHORIZATION_SERVERS:
            case OAuthErrorCode.OAUTH_DISCOVERY_FAILED_AUTHORIZATION_SERVER:
            case OAuthErrorCode.OAUTH_DISCOVERY_MISSING_ENDPOINTS:
                return {
                    title: "Could not auto-discover OAuth settings",
                    description:
                        "We couldn't discover the OAuth configuration from the MCP URL. Make sure the server exposes standard OAuth metadata or provide a client ID manually.",
                };
            case OAuthErrorCode.OAUTH_TOKEN_MISSING_ACCESS_TOKEN:
            case OAuthErrorCode.OAUTH_TOKEN_EXCHANGE_FAILED:
                return {
                    title: "OAuth token error",
                    description:
                        "We couldn't obtain an access token from the OAuth server. Try the flow again or contact the plugin provider.",
                };
            case OAuthErrorCode.OAUTH_INTEGRATION_NOT_FOUND:
                return {
                    title: "Plugin not found",
                    description:
                        "We couldn't find this plugin while finishing the OAuth flow. Try setting it up again.",
                };
            case OAuthErrorCode.OAUTH_INTEGRATION_WRONG_AUTH_TYPE:
                return {
                    title: "Invalid OAuth configuration",
                    description:
                        "This plugin is not configured to use OAuth 2.0. Check the authorization method and try again.",
                };
            case OAuthErrorCode.OAUTH_METADATA_INCOMPLETE:
                return {
                    title: "Incomplete OAuth metadata",
                    description:
                        "The stored OAuth information for this plugin is incomplete. Try reconnecting the plugin.",
                };
            case OAuthErrorCode.OAUTH_INVALID_STATE:
                return {
                    title: "OAuth session expired",
                    description:
                        "The OAuth session is no longer valid. Please restart the connection flow.",
                };
            default:
                return {
                    title: "OAuth error",
                    description:
                        body.message ||
                        "Something went wrong while performing the OAuth flow for this plugin.",
                };
        }
    }

    // Client registration / generic integration errors
    if (code === IntegrationErrorCode.CLIENT_REGISTRATION_FAILED) {
        return {
            title: "Failed to register OAuth client",
            description:
                "The plugin's OAuth client could not be dynamically registered. Check the MCP URL and scopes, or configure a client ID manually if supported.",
        };
    }

    if (code === IntegrationErrorCode.INVALID_CLIENT) {
        return {
            title: "Invalid OAuth client",
            description:
                "The OAuth provider returned an invalid client configuration. Verify the MCP server's dynamic client registration support.",
        };
    }

    // Fallback: show backend message if present
    return {
        title: "Error",
        description:
            body.message ||
            "Are the protocol, URL, and authorization details correct? Please check and try again.",
    };
};

export const AddCustomPluginModal = ({
    pluginToEdit,
}: {
    pluginToEdit?: AwaitedReturnType<typeof getMCPPluginById>;
}) => {
    const router = useRouter();
    const { toast } = useToast();
    const canCreate = usePermission(Action.Create, ResourceType.PluginSettings);
    const canEdit = usePermission(Action.Update, ResourceType.PluginSettings);

    const isEditMode = !!pluginToEdit;
    const canPerformAction = isEditMode ? canEdit : canCreate;

    const form = useForm<
        AddCustomPluginFormValues,
        any,
        AddCustomPluginFormValues
    >({
        resolver: zodResolver(addCustomPluginSchema),
        defaultValues: isEditMode
            ? convertApiDataToFormData(pluginToEdit!)
            : getEmptyDefaultValues(),
        mode: "all",
        reValidateMode: "onChange",
        criteriaMode: "firstError",
    });

    const watchedAuthMethod = form.watch("authMethod");
    const isOauth2 = watchedAuthMethod === CUSTOM_MCP_AUTH_METHODS.OAUTH2;
    const dynamicRegistration = form.watch("dynamicRegistration");

    // Reset dynamic registration when switching away from OAuth2
    useEffect(() => {
        if (!isOauth2) {
            form.setValue("dynamicRegistration", false);
        }
    }, [isOauth2, form]);

    const { fields, append, remove } = useFieldArray({
        control: form.control,
        name: "headers",
    });

    const [createPluginAction, { loading: isCreatePluginLoading }] =
        useAsyncAction(async (data: AddCustomPluginFormValues) => {
            try {
                const payload = convertFormDataToApiPayload(data);

                const plugin = await createMCPCustomPlugin(payload);

                await revalidateServerSidePath("/settings/plugins");

                toast({
                    variant: "success",
                    title: "Custom plugin created successfully",
                    description: `The plugin "${data.name}" has been created.`,
                });

                router.push(`/settings/plugins/custom/${plugin.id}`);
            } catch (error) {
                console.warn("Error creating custom plugin:", error);

                const friendly = getFriendlyErrorMessage(error);

                toast({
                    variant: "danger",
                    title: friendly.title,
                    description: friendly.description,
                });
            }
        });

    const [updatePluginAction, { loading: isUpdatePluginLoading }] =
        useAsyncAction(async (data: AddCustomPluginFormValues) => {
            try {
                if (!pluginToEdit) return;

                const payload = convertFormDataToApiPayload(data);

                await updateMCPCustomPlugin(pluginToEdit.id, payload);

                await revalidateServerSidePath("/settings/plugins");

                toast({
                    variant: "success",
                    title: "Custom plugin updated",
                    description: `The plugin "${data.name}" has been updated.`,
                });

                router.push(`/settings/plugins/custom/${pluginToEdit.id}`);
            } catch (error) {
                console.warn("Error updating custom plugin:", error);

                const friendly = getFriendlyErrorMessage(error);

                toast({
                    variant: "danger",
                    title: friendly.title,
                    description: friendly.description,
                });
            }
        });

    const handleSubmit = form.handleSubmit((data) => {
        if (isEditMode) {
            updatePluginAction(data);
        } else {
            createPluginAction(data);
        }
    });

    const isLoading = isCreatePluginLoading || isUpdatePluginLoading;

    const watchedApiKeyHeader = form.watch("apiKeyHeader");
    const watchedHeaders = form.watch("headers");

    const manuallyOverriddenHeader = useMemo(() => {
        const authManagedHeaders = new Set<string>();
        const currentAuthMethod = form.getValues("authMethod");

        if (
            currentAuthMethod === CUSTOM_MCP_AUTH_METHODS.BEARER ||
            currentAuthMethod === CUSTOM_MCP_AUTH_METHODS.BASIC ||
            currentAuthMethod === CUSTOM_MCP_AUTH_METHODS.OAUTH2
        ) {
            authManagedHeaders.add("authorization");
        } else if (
            currentAuthMethod === CUSTOM_MCP_AUTH_METHODS.API_KEY &&
            watchedApiKeyHeader?.trim()
        ) {
            authManagedHeaders.add(watchedApiKeyHeader.trim().toLowerCase());
        }

        return watchedHeaders.find((h) =>
            authManagedHeaders.has(h.key.trim().toLowerCase()),
        );
    }, [form, watchedApiKeyHeader, watchedHeaders]);

    return (
        <MagicModalContext
            value={{
                closeable: !isLoading,
            }}>
            <Dialog open onOpenChange={() => router.push("/settings/plugins")}>
                <DialogContent className="max-w-2xl overflow-x-hidden">
                    <DialogHeader>
                        <DialogTitle>
                            {isEditMode
                                ? "Edit Custom Plugin"
                                : "Add Custom Plugin"}
                        </DialogTitle>
                    </DialogHeader>

                    <div className="flex flex-col gap-4 py-4">
                        <Controller
                            name="name"
                            control={form.control}
                            render={({ field, fieldState }) => (
                                <FormControl.Root>
                                    <FormControl.Label>
                                        Plugin Name
                                    </FormControl.Label>
                                    <FormControl.Input>
                                        <Input
                                            size="md"
                                            placeholder="My Custom Plugin"
                                            disabled={!canPerformAction}
                                            {...field}
                                        />
                                    </FormControl.Input>
                                    {fieldState.error && (
                                        <FormControl.Error>
                                            {fieldState.error.message}
                                        </FormControl.Error>
                                    )}
                                </FormControl.Root>
                            )}
                        />

                        <Controller
                            name="description"
                            control={form.control}
                            render={({ field, fieldState }) => (
                                <FormControl.Root>
                                    <FormControl.Label>
                                        Description (Optional)
                                    </FormControl.Label>
                                    <FormControl.Input>
                                        <Input
                                            size="md"
                                            placeholder="A brief description of the plugin"
                                            disabled={!canPerformAction}
                                            {...field}
                                        />
                                    </FormControl.Input>
                                    {fieldState.error && (
                                        <FormControl.Error>
                                            {fieldState.error.message}
                                        </FormControl.Error>
                                    )}
                                </FormControl.Root>
                            )}
                        />

                        <Controller
                            name="logoUrl"
                            control={form.control}
                            render={({ field, fieldState }) => (
                                <FormControl.Root>
                                    <FormControl.Label>
                                        Logo URL (Optional)
                                    </FormControl.Label>
                                    <FormControl.Input>
                                        <div className="flex min-w-0 items-center gap-2">
                                            <Input
                                                size="md"
                                                placeholder="https://example.com/logo.png"
                                                disabled={!canPerformAction}
                                                {...field}
                                            />
                                            <Avatar className="bg-card-lv3 group-disabled/link:bg-card-lv3/50 size-10 shrink-0 rounded-lg p-1">
                                                {(field.value && (
                                                    <AvatarImage
                                                        src={field.value}
                                                        className="object-contain"
                                                    />
                                                )) || (
                                                    <ImageOff className="text-text-tertiary m-auto h-6 w-6" />
                                                )}
                                            </Avatar>
                                        </div>
                                    </FormControl.Input>
                                    {fieldState.error && (
                                        <FormControl.Error>
                                            {fieldState.error.message}
                                        </FormControl.Error>
                                    )}
                                </FormControl.Root>
                            )}
                        />

                        <Controller
                            name="baseUrl"
                            control={form.control}
                            render={({ field, fieldState }) => (
                                <FormControl.Root>
                                    <FormControl.Label>URL</FormControl.Label>
                                    <FormControl.Input>
                                        <Input
                                            size="md"
                                            placeholder="https://example.com/mcp"
                                            disabled={!canPerformAction}
                                            {...field}
                                        />
                                    </FormControl.Input>
                                    {fieldState.error && (
                                        <FormControl.Error>
                                            {fieldState.error.message}
                                        </FormControl.Error>
                                    )}
                                </FormControl.Root>
                            )}
                        />

                        <Controller
                            name="protocol"
                            control={form.control}
                            render={({ field, fieldState }) => (
                                <FormControl.Root>
                                    <FormControl.Label>
                                        Protocol
                                    </FormControl.Label>

                                    <Select
                                        value={field.value}
                                        onValueChange={field.onChange}
                                        disabled={!canPerformAction}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select a protocol" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem
                                                value={
                                                    CUSTOM_MCP_PROTOCOLS.HTTP
                                                }>
                                                HTTP
                                            </SelectItem>
                                            <SelectItem
                                                value={
                                                    CUSTOM_MCP_PROTOCOLS.SSE
                                                }>
                                                SSE
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>

                                    {fieldState.error && (
                                        <FormControl.Error>
                                            {fieldState.error.message}
                                        </FormControl.Error>
                                    )}
                                </FormControl.Root>
                            )}
                        />

                        <Controller
                            name="authMethod"
                            control={form.control}
                            render={({ field, fieldState }) => (
                                <FormControl.Root>
                                    <FormControl.Label>
                                        Authorization
                                    </FormControl.Label>
                                    <Select
                                        value={field.value}
                                        onValueChange={field.onChange}
                                        disabled={!canPerformAction}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select a method" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem
                                                value={
                                                    CUSTOM_MCP_AUTH_METHODS.NONE
                                                }>
                                                None
                                            </SelectItem>
                                            <SelectItem
                                                value={
                                                    CUSTOM_MCP_AUTH_METHODS.BEARER
                                                }>
                                                Bearer Token
                                            </SelectItem>
                                            <SelectItem
                                                value={
                                                    CUSTOM_MCP_AUTH_METHODS.BASIC
                                                }>
                                                Basic Auth
                                            </SelectItem>
                                            <SelectItem
                                                value={
                                                    CUSTOM_MCP_AUTH_METHODS.API_KEY
                                                }>
                                                API Key
                                            </SelectItem>
                                            <SelectItem
                                                value={
                                                    CUSTOM_MCP_AUTH_METHODS.OAUTH2
                                                }>
                                                OAuth 2.0
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                    {fieldState.error && (
                                        <FormControl.Error>
                                            {fieldState.error.message}
                                        </FormControl.Error>
                                    )}
                                </FormControl.Root>
                            )}
                        />

                        {watchedAuthMethod ===
                            CUSTOM_MCP_AUTH_METHODS.BEARER && (
                            <Controller
                                name="bearerToken"
                                control={form.control}
                                render={({ field, fieldState }) => (
                                    <FormControl.Root>
                                        <FormControl.Label>
                                            Bearer Token
                                        </FormControl.Label>
                                        <FormControl.Input>
                                            <Input
                                                size="md"
                                                type="password"
                                                placeholder="Enter your token"
                                                disabled={!canPerformAction}
                                                {...field}
                                            />
                                        </FormControl.Input>
                                        {fieldState.error && (
                                            <FormControl.Error>
                                                {fieldState.error.message}
                                            </FormControl.Error>
                                        )}
                                    </FormControl.Root>
                                )}
                            />
                        )}

                        {watchedAuthMethod ===
                            CUSTOM_MCP_AUTH_METHODS.BASIC && (
                            <div className="grid grid-cols-2 gap-2">
                                <Controller
                                    name="basicUser"
                                    control={form.control}
                                    render={({ field, fieldState }) => (
                                        <FormControl.Root>
                                            <FormControl.Label>
                                                Username
                                            </FormControl.Label>
                                            <FormControl.Input>
                                                <Input
                                                    size="md"
                                                    placeholder="Username"
                                                    disabled={!canPerformAction}
                                                    {...field}
                                                />
                                            </FormControl.Input>
                                            {fieldState.error && (
                                                <FormControl.Error>
                                                    {fieldState.error.message}
                                                </FormControl.Error>
                                            )}
                                        </FormControl.Root>
                                    )}
                                />
                                <Controller
                                    name="basicPassword"
                                    control={form.control}
                                    render={({ field, fieldState }) => (
                                        <FormControl.Root>
                                            <FormControl.Label>
                                                Password
                                            </FormControl.Label>
                                            <FormControl.Input>
                                                <Input
                                                    size="md"
                                                    type="password"
                                                    placeholder="Password"
                                                    disabled={!canPerformAction}
                                                    {...field}
                                                />
                                            </FormControl.Input>
                                            {fieldState.error && (
                                                <FormControl.Error>
                                                    {fieldState.error.message}
                                                </FormControl.Error>
                                            )}
                                        </FormControl.Root>
                                    )}
                                />
                            </div>
                        )}

                        {watchedAuthMethod ===
                            CUSTOM_MCP_AUTH_METHODS.API_KEY && (
                            <div className="grid grid-cols-2 gap-2">
                                <Controller
                                    name="apiKeyHeader"
                                    control={form.control}
                                    render={({ field, fieldState }) => (
                                        <FormControl.Root>
                                            <FormControl.Label>
                                                Header Name
                                            </FormControl.Label>
                                            <FormControl.Input>
                                                <Input
                                                    size="md"
                                                    placeholder="e.g., X-API-Key"
                                                    disabled={!canPerformAction}
                                                    {...field}
                                                />
                                            </FormControl.Input>
                                            {fieldState.error && (
                                                <FormControl.Error>
                                                    {fieldState.error.message}
                                                </FormControl.Error>
                                            )}
                                        </FormControl.Root>
                                    )}
                                />
                                <Controller
                                    name="apiKey"
                                    control={form.control}
                                    render={({ field, fieldState }) => (
                                        <FormControl.Root>
                                            <FormControl.Label>
                                                API Key
                                            </FormControl.Label>
                                            <FormControl.Input>
                                                <Input
                                                    size="md"
                                                    type="password"
                                                    placeholder="Your API Key"
                                                    disabled={!canPerformAction}
                                                    {...field}
                                                />
                                            </FormControl.Input>
                                            {fieldState.error && (
                                                <FormControl.Error>
                                                    {fieldState.error.message}
                                                </FormControl.Error>
                                            )}
                                        </FormControl.Root>
                                    )}
                                />
                            </div>
                        )}

                        {watchedAuthMethod ===
                            CUSTOM_MCP_AUTH_METHODS.OAUTH2 && (
                            <div className="space-y-4">
                                <div className="flex items-center space-x-2">
                                    <Checkbox
                                        id="dynamicRegistration"
                                        checked={dynamicRegistration}
                                        onCheckedChange={(c) => {
                                            form.setValue(
                                                "dynamicRegistration",
                                                c as boolean,
                                            );
                                            if (c) {
                                                form.setValue("clientId", "");
                                                form.setValue(
                                                    "clientSecret",
                                                    "",
                                                );
                                                form.setValue(
                                                    "oauthScopes",
                                                    [],
                                                );
                                            }
                                        }}
                                    />
                                    <label htmlFor="dynamicRegistration">
                                        Use Dynamic Client Registration
                                    </label>
                                </div>
                                {!dynamicRegistration && (
                                    <>
                                        <Controller
                                            name="clientId"
                                            control={form.control}
                                            render={({ field, fieldState }) => (
                                                <FormControl.Root>
                                                    <FormControl.Label>
                                                        Client ID
                                                    </FormControl.Label>
                                                    <FormControl.Input>
                                                        <Input
                                                            size="md"
                                                            placeholder="OAuth 2.0 Client ID"
                                                            disabled={
                                                                !canPerformAction
                                                            }
                                                            {...field}
                                                        />
                                                    </FormControl.Input>
                                                    {fieldState.error && (
                                                        <FormControl.Error>
                                                            {
                                                                fieldState.error
                                                                    .message
                                                            }
                                                        </FormControl.Error>
                                                    )}
                                                </FormControl.Root>
                                            )}
                                        />
                                        <Controller
                                            name="clientSecret"
                                            control={form.control}
                                            render={({ field, fieldState }) => (
                                                <FormControl.Root>
                                                    <FormControl.Label>
                                                        Client Secret (Optional)
                                                    </FormControl.Label>
                                                    <FormControl.Input>
                                                        <Input
                                                            size="md"
                                                            type="password"
                                                            placeholder="OAuth 2.0 Client Secret"
                                                            disabled={
                                                                !canPerformAction
                                                            }
                                                            {...field}
                                                        />
                                                    </FormControl.Input>
                                                    {fieldState.error && (
                                                        <FormControl.Error>
                                                            {
                                                                fieldState.error
                                                                    .message
                                                            }
                                                        </FormControl.Error>
                                                    )}
                                                </FormControl.Root>
                                            )}
                                        />
                                        <Controller
                                            name="oauthScopes"
                                            control={form.control}
                                            render={({ field, fieldState }) => (
                                                <FormControl.Root>
                                                    <FormControl.Label>
                                                        Scopes (Comma-separated,
                                                        Optional)
                                                    </FormControl.Label>
                                                    <FormControl.Input>
                                                        <Input
                                                            size="md"
                                                            placeholder="e.g., read,write,profile"
                                                            disabled={
                                                                !canPerformAction
                                                            }
                                                            value={
                                                                Array.isArray(
                                                                    field.value,
                                                                )
                                                                    ? field.value.join(
                                                                          ", ",
                                                                      )
                                                                    : ""
                                                            }
                                                            onChange={(e) => {
                                                                const value =
                                                                    e.target
                                                                        .value;
                                                                const scopes =
                                                                    value
                                                                        .split(
                                                                            ",",
                                                                        )
                                                                        .map(
                                                                            (
                                                                                s,
                                                                            ) =>
                                                                                s.trim(),
                                                                        )
                                                                        .filter(
                                                                            Boolean,
                                                                        );
                                                                field.onChange(
                                                                    scopes,
                                                                );
                                                            }}
                                                        />
                                                    </FormControl.Input>
                                                    {fieldState.error && (
                                                        <FormControl.Error>
                                                            {
                                                                fieldState.error
                                                                    .message
                                                            }
                                                        </FormControl.Error>
                                                    )}
                                                </FormControl.Root>
                                            )}
                                        />
                                    </>
                                )}
                            </div>
                        )}

                        <hr className="my-2" />

                        <FormControl.Root>
                            <FormControl.Label>
                                Custom Headers (Optional)
                            </FormControl.Label>
                            <div className="flex flex-col gap-2">
                                {fields.map((field, index) => (
                                    <div
                                        key={field.id}
                                        className="flex items-start gap-2">
                                        <Controller
                                            name={`headers.${index}.key`}
                                            control={form.control}
                                            render={({
                                                field: inputField,
                                                fieldState,
                                            }) => (
                                                <div className="min-w-0 flex-1">
                                                    <Input
                                                        size="md"
                                                        placeholder="Header Key"
                                                        disabled={
                                                            !canPerformAction
                                                        }
                                                        {...inputField}
                                                    />
                                                    {fieldState.error && (
                                                        <FormControl.Error>
                                                            {
                                                                fieldState.error
                                                                    .message
                                                            }
                                                        </FormControl.Error>
                                                    )}
                                                </div>
                                            )}
                                        />

                                        <Controller
                                            name={`headers.${index}.value`}
                                            control={form.control}
                                            render={({
                                                field: inputField,
                                                fieldState,
                                            }) => (
                                                <div className="min-w-0 flex-1">
                                                    <Input
                                                        size="md"
                                                        placeholder="Header Value"
                                                        disabled={
                                                            !canPerformAction
                                                        }
                                                        {...inputField}
                                                    />
                                                    {fieldState.error && (
                                                        <FormControl.Error>
                                                            {
                                                                fieldState.error
                                                                    .message
                                                            }
                                                        </FormControl.Error>
                                                    )}
                                                </div>
                                            )}
                                        />

                                        {fields.length > 1 && (
                                            <Button
                                                variant="error"
                                                size="icon-sm"
                                                className="text-muted-foreground hover:text-destructive shrink-0"
                                                disabled={!canPerformAction}
                                                onClick={() => remove(index)}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </div>
                                ))}
                            </div>

                            <Button
                                type="button"
                                variant="helper"
                                size="sm"
                                className="mt-2 w-full"
                                disabled={!canPerformAction}
                                onClick={() => append({ key: "", value: "" })}>
                                Add Header
                            </Button>

                            {form.formState.errors.headers?.root && (
                                <FormControl.Error>
                                    {form.formState.errors.headers.root.message}
                                </FormControl.Error>
                            )}

                            {manuallyOverriddenHeader && (
                                <FormControl.Error>
                                    The "{manuallyOverriddenHeader.key}" header
                                    will be overridden by your Authorization
                                    selection.
                                </FormControl.Error>
                            )}
                        </FormControl.Root>
                    </div>
                    <DialogFooter className="flex flex-col items-end gap-2">
                        <div>
                            <DialogClose asChild>
                                <Button
                                    size="md"
                                    variant="cancel"
                                    disabled={isLoading}>
                                    Go back
                                </Button>
                            </DialogClose>
                            <Button
                                size="md"
                                variant="primary"
                                loading={isLoading}
                                disabled={
                                    !canPerformAction ||
                                    !form.formState.isValid ||
                                    isLoading
                                }
                                onClick={handleSubmit}>
                                {isEditMode ? "Update Plugin" : "Create Plugin"}
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </MagicModalContext>
    );
};

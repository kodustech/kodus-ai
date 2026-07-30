"use client";

import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Badge } from "@components/ui/badge";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Textarea } from "@components/ui/textarea";
import { useSuspenseGetLLMProviders } from "@services/organizationParameters/hooks";
import { ExternalLinkIcon, InfoIcon, KeyRoundIcon } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../_types";

/**
 * Renders the credential inputs appropriate for the active provider:
 * - Google Vertex AI — SA JSON textarea + location input
 * - Amazon Bedrock — access key id, secret, region, optional session token
 * - Everything else — single API-key textarea (same behavior as ByokKeyInput)
 *
 * Used in the manual wizard. Curated flow's connect panel uses the simpler
 * single-field ByokKeyInput since curated cards never target Vertex/Bedrock.
 */
export const ByokCredentialsInput = () => {
    const form = useFormContext<EditKeyForm>();
    const { providers } = useSuspenseGetLLMProviders();

    const provider = form.watch("provider");

    if (provider === "google_vertex") return <VertexFields />;
    if (provider === "amazon_bedrock") return <BedrockFields />;

    const foundProvider = providers.find((p) => p.id === provider);
    if (!foundProvider?.requiresApiKey) return null;

    return (
        <Controller
            name="apiKey"
            control={form.control}
            render={({ field }) => (
                <FormControl.Root>
                    <FormControl.Label htmlFor={field.name}>
                        Key
                    </FormControl.Label>
                    <FormControl.Input>
                        <Textarea
                            id={field.name}
                            value={field.value}
                            onChange={field.onChange}
                            className="max-h-56 min-h-32"
                            placeholder="Provide your key"
                        />
                    </FormControl.Input>
                </FormControl.Root>
            )}
        />
    );
};

const VertexFields = () => {
    const form = useFormContext<EditKeyForm>();

    return (
        <div className="flex flex-col gap-4">
            <BetaProviderNotice />

            <Alert variant="info">
                <InfoIcon />
                <AlertTitle className="text-balance">
                    Service account JSON
                </AlertTitle>
                <AlertDescription className="text-pretty">
                    Paste the contents of your service account JSON file
                    directly (base64-encoded also works). Kodus extracts{" "}
                    <code className="bg-card-lv2 rounded px-1 py-0.5 font-mono text-[11px]">
                        project_id
                    </code>{" "}
                    from the JSON automatically — just tell us the region.
                </AlertDescription>
            </Alert>

            <Controller
                name="apiKey"
                control={form.control}
                render={({ field }) => (
                    <FormControl.Root>
                        <FormControl.Label htmlFor={field.name}>
                            Service Account JSON
                        </FormControl.Label>
                        <FormControl.Input>
                            <Textarea
                                id={field.name}
                                value={field.value}
                                onChange={field.onChange}
                                className="max-h-56 min-h-32 font-mono text-xs"
                                placeholder="eyJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIsICJwcm9qZWN0X2lkIjog..."
                            />
                        </FormControl.Input>
                    </FormControl.Root>
                )}
            />

            <Controller
                name="vertexLocation"
                control={form.control}
                render={({ field }) => (
                    <FormControl.Root>
                        <FormControl.Label htmlFor={field.name}>
                            Region
                        </FormControl.Label>
                        <FormControl.Input>
                            <Input
                                id={field.name}
                                size="md"
                                value={field.value ?? ""}
                                onChange={(e) =>
                                    field.onChange(e.target.value || null)
                                }
                                placeholder="global"
                            />
                        </FormControl.Input>
                        <FormControl.Helper>
                            Leave empty for the global endpoint (recommended).
                            Pin a region (e.g. us-east5) only for data
                            residency.
                        </FormControl.Helper>
                    </FormControl.Root>
                )}
            />
        </div>
    );
};

const BedrockFields = () => {
    const form = useFormContext<EditKeyForm>();

    return (
        <div className="flex flex-col gap-4">
            <BetaProviderNotice />

            <Alert variant="info">
                <InfoIcon />
                <AlertTitle className="text-balance">
                    Bedrock API key (recommended)
                </AlertTitle>
                <AlertDescription className="text-pretty">
                    AWS released API keys for Bedrock in 2025 — single token,
                    no access-key/secret juggling. Generate one in the AWS
                    console under Bedrock → API keys, or keep the old IAM
                    user flow below under Advanced.
                </AlertDescription>
            </Alert>

            <Controller
                name="awsBearerToken"
                control={form.control}
                render={({ field, fieldState }) => (
                    <FormControl.Root>
                        <FormControl.Label htmlFor={field.name}>
                            Bedrock API key
                        </FormControl.Label>
                        <FormControl.Input>
                            <Textarea
                                id={field.name}
                                value={field.value ?? ""}
                                onChange={(e) =>
                                    field.onChange(e.target.value || null)
                                }
                                className="max-h-40 min-h-24 font-mono text-xs"
                                placeholder="ABSK... (bearer token from AWS Bedrock console)"
                                autoComplete="off"
                                error={fieldState.error}
                            />
                        </FormControl.Input>
                        <FormControl.Helper>
                            <a
                                href="https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-generate.html"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary-light inline-flex items-center gap-1 hover:underline">
                                How to generate a Bedrock API key
                                <ExternalLinkIcon size={11} />
                            </a>
                        </FormControl.Helper>
                        <FormControl.Error>
                            {fieldState.error?.message}
                        </FormControl.Error>
                    </FormControl.Root>
                )}
            />

            <Controller
                name="awsRegion"
                control={form.control}
                render={({ field }) => (
                    <FormControl.Root>
                        <FormControl.Label htmlFor={field.name}>
                            Region
                        </FormControl.Label>
                        <FormControl.Input>
                            <Input
                                id={field.name}
                                size="md"
                                className="max-w-xs"
                                value={field.value ?? ""}
                                onChange={(e) =>
                                    field.onChange(e.target.value || null)
                                }
                                placeholder="us-east-1"
                            />
                        </FormControl.Input>
                        <FormControl.Helper>
                            e.g. us-east-1, us-west-2, eu-central-1.
                        </FormControl.Helper>
                    </FormControl.Root>
                )}
            />

            <BedrockAdvancedIamFields />
        </div>
    );
};

const BedrockAdvancedIamFields = () => {
    const form = useFormContext<EditKeyForm>();

    return (
        <Collapsible className="border-card-lv2 rounded-lg border">
            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    className="text-text-secondary hover:text-text-primary hover:bg-card-lv2/40 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors data-[state=open]:rounded-b-none">
                    <span className="flex items-center gap-2">
                        <KeyRoundIcon className="size-4" />
                        Advanced — use IAM user credentials instead
                    </span>
                    <CollapsibleIndicator />
                </button>
            </CollapsibleTrigger>

            <CollapsibleContent>
                <div className="border-card-lv2 flex flex-col gap-4 border-t px-3 py-4">
                    <p className="text-text-tertiary text-xs text-pretty">
                        Static AWS access key + secret. Kept for teams that
                        haven&apos;t migrated to Bedrock API keys. Requires{" "}
                        <code className="bg-card-lv2 rounded px-1 py-0.5 font-mono text-[11px]">
                            bedrock:InvokeModel
                        </code>{" "}
                        permission. Test validates via STS GetCallerIdentity
                        — no Bedrock call made.
                    </p>

                    <Controller
                        name="awsAccessKeyId"
                        control={form.control}
                        render={({ field, fieldState }) => (
                            <FormControl.Root>
                                <FormControl.Label htmlFor={field.name}>
                                    Access Key ID
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Input
                                        id={field.name}
                                        size="md"
                                        value={field.value ?? ""}
                                        onChange={(e) =>
                                            field.onChange(
                                                e.target.value || null,
                                            )
                                        }
                                        placeholder="AKIA..."
                                        autoComplete="off"
                                        error={fieldState.error}
                                    />
                                </FormControl.Input>
                                <FormControl.Error>
                                    {fieldState.error?.message}
                                </FormControl.Error>
                            </FormControl.Root>
                        )}
                    />

                    <Controller
                        name="awsSecretAccessKey"
                        control={form.control}
                        render={({ field, fieldState }) => (
                            <FormControl.Root>
                                <FormControl.Label htmlFor={field.name}>
                                    Secret Access Key
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Textarea
                                        id={field.name}
                                        value={field.value ?? ""}
                                        onChange={(e) =>
                                            field.onChange(
                                                e.target.value || null,
                                            )
                                        }
                                        className="max-h-40 min-h-24 font-mono text-xs"
                                        placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                                        autoComplete="off"
                                        error={fieldState.error}
                                    />
                                </FormControl.Input>
                                <FormControl.Error>
                                    {fieldState.error?.message}
                                </FormControl.Error>
                            </FormControl.Root>
                        )}
                    />

                    <Controller
                        name="awsSessionToken"
                        control={form.control}
                        render={({ field }) => (
                            <FormControl.Root>
                                <FormControl.Label htmlFor={field.name}>
                                    Session Token{" "}
                                    <span className="text-text-tertiary font-normal">
                                        (optional)
                                    </span>
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Textarea
                                        id={field.name}
                                        value={field.value ?? ""}
                                        onChange={(e) =>
                                            field.onChange(
                                                e.target.value || null,
                                            )
                                        }
                                        className="max-h-32 min-h-16 font-mono text-xs"
                                        placeholder="FwoGZXIvYXdzE..."
                                        autoComplete="off"
                                    />
                                </FormControl.Input>
                                <FormControl.Helper>
                                    Only for AWS STS temporary credentials.
                                </FormControl.Helper>
                            </FormControl.Root>
                        )}
                    />
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
};

const BetaProviderNotice = () => (
    <div className="border-card-lv2 bg-card-lv2/40 flex items-center gap-2 rounded-md border px-3 py-2 text-xs text-pretty">
        <Badge variant="helper" size="xs">
            Beta
        </Badge>
        <span className="text-text-secondary">
            This integration is newer and less battle-tested than other
            providers. Report any issues you hit — we iterate fast.
        </span>
    </div>
);

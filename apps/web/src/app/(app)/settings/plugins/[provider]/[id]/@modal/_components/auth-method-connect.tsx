"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardContent } from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import { RadioGroup } from "@components/ui/radio-group";
import { useToast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { connectMCPPluginWithToken } from "@services/mcp-manager/fetch";
import type { MCPAuthMethod } from "@services/mcp-manager/types";
import { KeyRoundIcon, PlugIcon } from "lucide-react";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

const isOAuthMethod = (method: MCPAuthMethod) =>
    method.type.toLowerCase() === "oauth2";

export const AuthMethodConnect = ({
    integrationId,
    appName,
    authMethods,
    canEdit,
    isDefault,
    onAuthorize,
    isAuthorizing,
}: {
    integrationId: string;
    appName: string;
    authMethods: MCPAuthMethod[];
    canEdit: boolean;
    isDefault: boolean;
    onAuthorize: (authMethodId: string) => void;
    isAuthorizing: boolean;
}) => {
    const router = useRouter();
    const { toast } = useToast();

    const [selectedMethodId, setSelectedMethodId] = useState(
        () => authMethods.find((m) => m.default)?.id ?? authMethods[0]?.id,
    );
    const [values, setValues] = useState<Record<string, string>>({});

    const selectedMethod = useMemo(
        () => authMethods.find((m) => m.id === selectedMethodId),
        [authMethods, selectedMethodId],
    );

    const requiredFilled = (selectedMethod?.userFields ?? [])
        .filter((field) => field.required)
        .every((field) => (values[field.name] ?? "").trim().length > 0);

    const [connectWithToken, { loading: isConnecting }] = useAsyncAction(
        async () => {
            if (!selectedMethod) return;

            const secretField = selectedMethod.userFields?.find(
                (field) => field.secret,
            );
            const secret = secretField
                ? (values[secretField.name] ?? "").trim()
                : "";

            const fields: Record<string, string> = {};
            for (const field of selectedMethod.userFields ?? []) {
                if (field.secret) continue;
                const value = (values[field.name] ?? "").trim();
                if (value) fields[field.name] = value;
            }

            try {
                await connectMCPPluginWithToken({
                    integrationId,
                    authMethod: selectedMethod.id,
                    secret,
                    fields: Object.keys(fields).length > 0 ? fields : undefined,
                });

                await revalidateServerSidePath("/settings/plugins");

                toast({
                    variant: "success",
                    title: "Connected successfully",
                    description: `${appName} is now connected.`,
                });

                router.push("/settings/plugins");
            } catch {
                toast({
                    variant: "alert",
                    title: "Couldn't connect",
                    description:
                        "Please double-check your details and try again.",
                });
            }
        },
    );

    if (!selectedMethod) return null;

    return (
        <Card color="lv1" className="flex flex-col gap-4 px-4 py-4">
            {authMethods.length > 1 && (
                <RadioGroup.Root
                    value={selectedMethodId}
                    onValueChange={setSelectedMethodId}
                    className="grid-flow-col justify-start gap-6"
                    aria-label="Authentication method">
                    {authMethods.map((method) => (
                        <Label
                            key={method.id}
                            className="flex cursor-pointer items-center gap-2 text-sm">
                            <RadioGroup.Item
                                value={method.id}
                                disabled={!canEdit || isDefault}
                            />
                            {method.label ??
                                (isOAuthMethod(method) ? "OAuth" : "API token")}
                        </Label>
                    ))}
                </RadioGroup.Root>
            )}

            {isOAuthMethod(selectedMethod) ? (
                <div className="flex flex-col items-center gap-3 py-4">
                    <p className="text-text-secondary text-center text-sm text-pretty">
                        Authenticate with {appName} to connect this plugin.
                    </p>
                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<PlugIcon />}
                        loading={isAuthorizing}
                        disabled={!canEdit || isDefault}
                        onClick={() => onAuthorize(selectedMethod.id)}>
                        Authenticate with {appName}
                    </Button>
                </div>
            ) : (
                <CardContent className="flex flex-col gap-4 p-0">
                    {(selectedMethod.userFields ?? []).map((field) => (
                        <FormControl.Root key={field.name}>
                            <FormControl.Label htmlFor={field.name}>
                                {field.label ?? field.name}
                            </FormControl.Label>

                            <FormControl.Input>
                                <Input
                                    size="md"
                                    id={field.name}
                                    type={field.secret ? "password" : "text"}
                                    autoComplete="off"
                                    placeholder={
                                        field.required
                                            ? "This information is required"
                                            : "Optional"
                                    }
                                    value={values[field.name] ?? ""}
                                    disabled={!canEdit || isDefault}
                                    onChange={(e) =>
                                        setValues((prev) => ({
                                            ...prev,
                                            [field.name]: e.target.value,
                                        }))
                                    }
                                />
                            </FormControl.Input>
                        </FormControl.Root>
                    ))}

                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<KeyRoundIcon />}
                        loading={isConnecting}
                        disabled={!canEdit || isDefault || !requiredFilled}
                        onClick={() => connectWithToken()}>
                        Connect
                    </Button>
                </CardContent>
            )}
        </Card>
    );
};

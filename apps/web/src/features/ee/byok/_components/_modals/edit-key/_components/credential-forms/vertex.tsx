"use client";

import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Textarea } from "@components/ui/textarea";
import { InfoIcon } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../../_types";
import { BetaProviderNotice } from "./_shared";

/** Google Vertex AI — service-account JSON + region. */
export const VertexFields = () => {
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

import { Button } from "@components/ui/button";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Controller, useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../_types";

export const ByokAdvancedSettings = () => {
    const { control } = useFormContext<EditKeyForm>();

    return (
        <Collapsible>
            <CollapsibleTrigger asChild>
                <Button
                    type="button"
                    size="sm"
                    variant="helper"
                    leftIcon={<CollapsibleIndicator />}>
                    Advanced settings
                </Button>
            </CollapsibleTrigger>

            <CollapsibleContent>
                <div className="flex flex-col gap-4 pt-2">
                    <Controller
                        name="temperature"
                        control={control}
                        render={({ field, fieldState }) => (
                            <FormControl.Root>
                                <FormControl.Label htmlFor="temperature">
                                    Temperature
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Input
                                        id="temperature"
                                        type="number"
                                        min={0}
                                        max={2}
                                        step={0.1}
                                        placeholder="Default (0)"
                                        error={fieldState.error}
                                        value={
                                            field.value != null
                                                ? field.value
                                                : ""
                                        }
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            const num = parseFloat(val);
                                            field.onChange(
                                                val === "" || Number.isNaN(num)
                                                    ? null
                                                    : num,
                                            );
                                        }}
                                    />
                                </FormControl.Input>
                                <FormControl.Helper>
                                    Controls randomness (0 = deterministic, 2 =
                                    creative)
                                </FormControl.Helper>
                                <FormControl.Error>
                                    {fieldState.error?.message}
                                </FormControl.Error>
                            </FormControl.Root>
                        )}
                    />

                    <Controller
                        name="maxOutputTokens"
                        control={control}
                        render={({ field, fieldState }) => (
                            <FormControl.Root>
                                <FormControl.Label htmlFor="maxOutputTokens">
                                    Max output tokens
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Input
                                        id="maxOutputTokens"
                                        type="number"
                                        min={0}
                                        step={1}
                                        placeholder="Model default"
                                        error={fieldState.error}
                                        value={
                                            field.value != null
                                                ? field.value
                                                : ""
                                        }
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            const num = parseInt(val, 10);
                                            field.onChange(
                                                val === "" || Number.isNaN(num)
                                                    ? null
                                                    : num,
                                            );
                                        }}
                                    />
                                </FormControl.Input>
                                <FormControl.Helper>
                                    Maximum tokens in the response. 0 or empty
                                    uses model default.
                                </FormControl.Helper>
                                <FormControl.Error>
                                    {fieldState.error?.message}
                                </FormControl.Error>
                            </FormControl.Root>
                        )}
                    />

                    <Controller
                        name="maxInputTokens"
                        control={control}
                        render={({ field, fieldState }) => (
                            <FormControl.Root>
                                <FormControl.Label htmlFor="maxInputTokens">
                                    Max input tokens
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Input
                                        id="maxInputTokens"
                                        type="number"
                                        min={0}
                                        step={1}
                                        placeholder="No limit"
                                        error={fieldState.error}
                                        value={
                                            field.value != null
                                                ? field.value
                                                : ""
                                        }
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            const num = parseInt(val, 10);
                                            field.onChange(
                                                val === "" || Number.isNaN(num)
                                                    ? null
                                                    : num,
                                            );
                                        }}
                                    />
                                </FormControl.Input>
                                <FormControl.Helper>
                                    Maximum tokens sent in the prompt. 0 or
                                    empty means no limit.
                                </FormControl.Helper>
                                <FormControl.Error>
                                    {fieldState.error?.message}
                                </FormControl.Error>
                            </FormControl.Root>
                        )}
                    />

                    <Controller
                        name="maxConcurrentRequests"
                        control={control}
                        render={({ field, fieldState }) => (
                            <FormControl.Root>
                                <FormControl.Label htmlFor="maxConcurrentRequests">
                                    Max concurrent requests
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Input
                                        id="maxConcurrentRequests"
                                        type="number"
                                        min={0}
                                        step={1}
                                        placeholder="No limit"
                                        error={fieldState.error}
                                        value={
                                            field.value != null
                                                ? field.value
                                                : ""
                                        }
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            const num = parseInt(val, 10);
                                            field.onChange(
                                                val === "" || Number.isNaN(num)
                                                    ? null
                                                    : num,
                                            );
                                        }}
                                    />
                                </FormControl.Input>
                                <FormControl.Helper>
                                    Limits parallel LLM requests per review. Use
                                    if your provider has rate limits.
                                </FormControl.Helper>
                                <FormControl.Error>
                                    {fieldState.error?.message}
                                </FormControl.Error>
                            </FormControl.Root>
                        )}
                    />
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
};

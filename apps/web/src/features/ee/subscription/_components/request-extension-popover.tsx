"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { Textarea } from "@components/ui/textarea";
import { toast } from "@components/ui/toaster/use-toast";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { requestTrialExtension } from "../_services/billing/fetch";

export const RequestExtensionPopover = ({
    triggerLabel = "Request review",
}: {
    triggerLabel?: string;
}) => {
    const { teamId } = useSelectedTeamId();
    const [open, setOpen] = useState(false);
    const [teamSize, setTeamSize] = useState("");
    const [message, setMessage] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async () => {
        setSubmitting(true);
        try {
            const result = await requestTrialExtension({
                teamId,
                request: {
                    teamSize: teamSize ? Number(teamSize) : undefined,
                    message: message.trim() || undefined,
                },
            });

            if (!result?.success) {
                throw new Error(result?.message || "Request failed");
            }

            toast({
                variant: "success",
                title: "Request sent",
                description:
                    "We'll review your trial signals and follow up shortly.",
            });
            setOpen(false);
            setTeamSize("");
            setMessage("");
        } catch (error) {
            toast({
                variant: "warning",
                title: "Could not send request",
                description:
                    error instanceof Error
                        ? error.message
                        : "Please try again in a moment.",
            });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button size="xs" variant="helper">
                    {triggerLabel}
                </Button>
            </PopoverTrigger>
            <PopoverContent
                align="end"
                className="w-80"
                onOpenAutoFocus={(event) => event.preventDefault()}>
                <div className="flex flex-col gap-4">
                    <div>
                        <p className="text-text-primary text-sm font-semibold">
                            Request more trial reviews
                        </p>
                        <p className="text-text-secondary mt-1 text-xs">
                            Tell us about your team and we'll review your trial
                            signals.
                        </p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <Label
                            htmlFor="trial-ext-team-size"
                            className="text-xs">
                            Team size
                        </Label>
                        <Input
                            id="trial-ext-team-size"
                            type="number"
                            min={1}
                            inputMode="numeric"
                            placeholder="e.g. 12"
                            value={teamSize}
                            onChange={(event) =>
                                setTeamSize(event.target.value)
                            }
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="trial-ext-message" className="text-xs">
                            Anything we should know?
                        </Label>
                        <Textarea
                            id="trial-ext-message"
                            rows={3}
                            placeholder="What are you evaluating Kodus for?"
                            value={message}
                            onChange={(event) => setMessage(event.target.value)}
                        />
                    </div>

                    <Button
                        size="sm"
                        variant="primary"
                        loading={submitting}
                        onClick={handleSubmit}>
                        Send request
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
};

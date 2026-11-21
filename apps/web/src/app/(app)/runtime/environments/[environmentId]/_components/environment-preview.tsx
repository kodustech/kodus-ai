"use client";

import { useState } from "react";
import {
    PreviewFootnote,
    PreviewSideRow,
} from "@components/runtime/run-preview";
import { RuntimeSection } from "@components/runtime/section";
import { Button } from "@components/ui/button";
import { Label } from "@components/ui/label";
import { RadioGroup } from "@components/ui/radio-group";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission, usePermissionOnEvery } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { PreviewSecrets } from "@services/runtime/contracts";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { environmentPreviewHref } from "@services/runtime/model/preview";
import {
    useEnvironmentPreview,
    useUpdateEnvironmentSettings,
} from "@services/runtime/queries";

// The environment page's preview (docs/runtime/preview-urls.md §8.3): its
// base at the commit the last setup baked, and the owner's choice of secrets
// in this environment's previews (§7).

const SECRET_OPTIONS: Array<{ value: PreviewSecrets; label: string; hint: string }> = [
    {
        value: "none",
        label: "None (recommended)",
        hint: "The app boots like a pull request from a fork: integrations that need a key fail, and nothing a viewer clicks reaches a third party with your credentials.",
    },
    {
        value: "run",
        label: "Same as the Runs",
        hint: "Previews get the organization's secrets as placeholders, like a Run; the real value is added only on the way out to each secret's hosts. Never on a pull request from a fork.",
    },
];

export const EnvironmentPreviewSection = ({
    environmentId,
    repositoryIds,
    previewSecrets,
}: {
    environmentId: string;
    repositoryIds: string[];
    /** The environment's setting; absent: an environment without settings. */
    previewSecrets?: PreviewSecrets;
}) => {
    const allowed = usePermissionOnEvery(Action.Read, ResourceType.RuntimePreview, repositoryIds);
    const isOwner = usePermission(Action.Manage, ResourceType.RuntimePreview);
    const preview = useEnvironmentPreview(environmentId, allowed);
    if (!allowed || !preview.data) return null;
    const { offer, sha } = preview.data;
    if (!offer.available && offer.code === "preview_off") return null;

    return (
        <RuntimeSection
            id="preview"
            title="Preview"
            description="Open this environment in your browser as its last setup left it, to check the default branch or compare with a pull request.">
            {offer.available ? (
                <div className="flex flex-col gap-2">
                    <PreviewSideRow
                        title={`Main${sha ? ` at ${sha.slice(0, 7)}` : ""}`}
                        href={environmentPreviewHref(environmentId)}
                        view={preview.data.preview}
                    />
                    <PreviewFootnote offer={offer} views={[preview.data.preview]} />
                </div>
            ) : (
                <p className="text-text-secondary text-sm" role="status">
                    {offer.reason}
                </p>
            )}
            {isOwner && previewSecrets !== undefined && (
                <PreviewSecretsSetting
                    key={previewSecrets}
                    environmentId={environmentId}
                    setting={previewSecrets}
                />
            )}
        </RuntimeSection>
    );
};

const PreviewSecretsSetting = ({
    environmentId,
    setting,
}: {
    environmentId: string;
    setting: PreviewSecrets;
}) => {
    const [choice, setChoice] = useState<PreviewSecrets>(setting);
    const update = useUpdateEnvironmentSettings();
    const save = () =>
        update.mutate(
            { environmentId, previewSecrets: choice },
            {
                onSuccess: () =>
                    toast({
                        variant: "success",
                        title: "Preview secrets saved",
                        description: "It applies the next time a preview of this environment opens.",
                    }),
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't save the preview secrets",
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                            403: "Only an owner of the organization can change it.",
                        }),
                    }),
            },
        );
    return (
        <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (choice !== setting) save();
            }}>
            <span className="text-text-primary text-sm font-semibold">Secrets in previews</span>
            <RadioGroup.Root
                aria-label="Secrets in previews"
                value={choice}
                onValueChange={(value) => setChoice(value === "run" ? "run" : "none")}
                disabled={update.isPending}
                className="gap-2">
                {SECRET_OPTIONS.map((o) => (
                    <Label key={o.value} className="flex cursor-pointer items-start gap-3 text-sm leading-snug">
                        <RadioGroup.Item value={o.value} className="mt-0.5" />
                        <span className="flex flex-col gap-0.5">
                            <span className="text-text-primary">{o.label}</span>
                            <span className="text-text-secondary text-xs font-normal">{o.hint}</span>
                        </span>
                    </Label>
                ))}
            </RadioGroup.Root>
            <div>
                <Button type="submit" size="sm" variant="secondary" disabled={choice === setting} loading={update.isPending}>
                    Save
                </Button>
            </div>
        </form>
    );
};

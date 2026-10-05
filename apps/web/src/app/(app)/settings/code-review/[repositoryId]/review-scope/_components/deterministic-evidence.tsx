"use client";

import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { TriangleAlertIcon } from "lucide-react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { useCodeReviewConfig } from "src/app/(app)/settings/_components/context";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

import type { CodeReviewFormType, DeterministicToolId } from "../../../_types";

/**
 * The two scanners, and what each answers that the reviewer cannot.
 *
 * Both answer a question of FACT — is this exact package version named in an
 * advisory database, is this string a credential — rather than a question of
 * judgement, which the reviewer already does better.
 */
const TOOLS: Array<{
    value: DeterministicToolId;
    name: string;
    description: string;
}> = [
    {
        value: "dependencies",
        name: "Vulnerable dependencies",
        description:
            "Checks packages a pull request adds or bumps against public advisory databases, and reports only the vulnerabilities that change introduces — not the ones already in your tree.",
    },
    {
        value: "secrets",
        name: "Committed credentials",
        description:
            "Scans changed files for tokens, keys and private keys that should not be in the repository.",
    },
];

/** An enabled tool still stands down when the repo's own CI already covers it. */
const isToolEnabled = (mode: boolean | undefined) => mode === true;

export const DeterministicEvidence = () => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();

    const ciChecks = useWatch({
        control: form.control,
        name: "deterministicEvidence.ciChecks.value",
    });

    return (
        <div className="flex flex-col gap-3">
            {TOOLS.map((tool) => (
                <Controller
                    key={tool.value}
                    name={`deterministicEvidence.tools.${tool.value}.value`}
                    control={form.control}
                    defaultValue={
                        config?.deterministicEvidence?.tools?.[tool.value]
                            ?.value
                    }
                    render={({ field }) => (
                        <Button
                            size="sm"
                            variant="helper"
                            disabled={field.disabled}
                            onClick={() =>
                                field.onChange(!isToolEnabled(field.value))
                            }
                            className="w-full">
                            <CardHeader className="flex flex-row items-center justify-between gap-6">
                                <div className="flex flex-col gap-1">
                                    <div className="flex flex-row items-center gap-2">
                                        <Heading variant="h3">
                                            {tool.name}
                                        </Heading>

                                        <OverrideIndicatorForm
                                            fieldName={`deterministicEvidence.tools.${tool.value}`}
                                        />
                                    </div>

                                    <p className="text-text-secondary text-sm">
                                        {tool.description}
                                    </p>
                                </div>

                                <Switch
                                    decorative
                                    checked={isToolEnabled(field.value)}
                                />
                            </CardHeader>
                        </Button>
                    )}
                />
            ))}

            <Controller
                name="deterministicEvidence.ciChecks.value"
                control={form.control}
                defaultValue={config?.deterministicEvidence?.ciChecks?.value}
                render={({ field }) => (
                    <Button
                        size="sm"
                        variant="helper"
                        disabled={field.disabled}
                        onClick={() => field.onChange(!field.value)}
                        className="w-full">
                        <CardHeader className="flex flex-row items-center justify-between gap-6">
                            <div className="flex flex-col gap-1">
                                <div className="flex flex-row items-center gap-2">
                                    <Heading variant="h3">
                                        Use your CI's results as evidence
                                    </Heading>

                                    <OverrideIndicatorForm fieldName="deterministicEvidence.ciChecks" />
                                </div>

                                <p className="text-text-secondary text-sm">
                                    Lets Kody read the checks already on the
                                    commit, so a failing build becomes
                                    supporting evidence instead of something it
                                    repeats — and so a scanner above can stand
                                    down when your pipeline already covers it.
                                    Nothing is re-run.
                                </p>
                            </div>

                            <Switch decorative checked={field.value} />
                        </CardHeader>
                    </Button>
                )}
            />

            {ciChecks && (
                <Alert variant="warning">
                    <TriangleAlertIcon className="size-4" />
                    <AlertDescription>
                        <strong>
                            On GitHub this needs the Kodus app, not a personal
                            access token.
                        </strong>{" "}
                        GitHub Actions publishes its results as check runs,
                        which a personal access token cannot read — on a token
                        connection Kody sees only commit statuses, which most
                        repositories never publish. If your checks run on
                        Actions, install the app from Settings → Git or this
                        setting will have nothing to read.
                    </AlertDescription>
                </Alert>
            )}
        </div>
    );
};

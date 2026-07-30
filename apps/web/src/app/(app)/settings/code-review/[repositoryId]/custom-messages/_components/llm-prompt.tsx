import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { useShouldHideLLMPrompt } from "src/app/(app)/settings/_components/use-code-management-platform";

import { OverrideIndicator } from "../../../_components/override";
import type { IFormattedConfigProperty } from "../../../_types";

export const LLMPromptToggle = (props: {
    suggestionCopyPrompt: IFormattedConfigProperty<boolean>;
    initialState: IFormattedConfigProperty<boolean>;
    onsuggestionCopyPromptChangeAction: (value: boolean) => void;
    handleRevert: () => void;
    canEdit: boolean;
}) => {
    const shouldHide = useShouldHideLLMPrompt();

    if (shouldHide) return null;

    return (
        <div className="flex flex-col gap-4">
            <Button
                size="sm"
                variant="helper"
                className="w-full"
                disabled={!props.canEdit}
                onClick={() =>
                    props.onsuggestionCopyPromptChangeAction(
                        !props.suggestionCopyPrompt?.value,
                    )
                }>
                <CardHeader className="flex flex-row items-center justify-between gap-6 p-4">
                    <div>
                        <div className="mb-2 flex flex-row items-center gap-2">
                            <Heading variant="h3">
                                Enable LLM Prompt
                                <span className="ml-1.5 inline-flex items-center rounded-md bg-red-800 px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-blue-700/10 ring-inset">
                                    Not available on Bitbucket
                                </span>
                            </Heading>
                            <OverrideIndicator
                                currentValue={props.suggestionCopyPrompt?.value}
                                initialState={props.initialState}
                                handleRevert={props.handleRevert}
                            />
                        </div>
                        <p className="text-text-secondary">
                            When enabled, each suggestions will have a prompt
                            the user can copy to use with an LLM.
                        </p>
                    </div>
                    <Switch
                        decorative
                        checked={props.suggestionCopyPrompt?.value}
                    />
                </CardHeader>
            </Button>
        </div>
    );
};

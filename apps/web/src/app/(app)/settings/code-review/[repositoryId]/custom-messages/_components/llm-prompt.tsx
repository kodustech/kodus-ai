import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";

import { OverrideIndicator } from "../../../_components/override";
import type { IFormattedConfigProperty } from "../../../_types";

export const LLMPromptToggle = (props: {
    suggestionCopyPrompt: IFormattedConfigProperty<boolean>;
    initialState: IFormattedConfigProperty<boolean>;
    onsuggestionCopyPromptChangeAction: (value: boolean) => void;
    handleRevert: () => void;
    canEdit: boolean;
}) => {
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
                                Add a copyable prompt to each suggestion
                            </Heading>
                            <OverrideIndicator
                                currentValue={props.suggestionCopyPrompt?.value}
                                initialState={props.initialState}
                                handleRevert={props.handleRevert}
                            />
                        </div>
                        <p className="text-text-secondary">
                            Each suggestion gets a prompt the developer can
                            paste into an AI assistant to apply the fix.
                        </p>
                        <p className="text-text-secondary mt-1 text-sm">
                            On Bitbucket, the prompt is posted as a reply in
                            the same thread. With this off, Bitbucket comments
                            show no fix.
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

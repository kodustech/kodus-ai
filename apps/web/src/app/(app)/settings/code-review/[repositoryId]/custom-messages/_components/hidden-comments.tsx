"use client";

import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { useShouldHideHiddenComments } from "src/app/(app)/settings/_components/use-code-management-platform";

import { OverrideIndicator } from "../../../_components/override";
import { IFormattedConfigProperty } from "../../../_types";

export const HiddenComments = (props: {
    hideComments: IFormattedConfigProperty<boolean>;
    initialState: IFormattedConfigProperty<boolean>;
    onHideCommentsChangeAction: (value: boolean) => void;
    handleRevert: () => void;
    canEdit: boolean;
}) => {
    const shouldHide = useShouldHideHiddenComments();

    if (shouldHide) return null;

    return (
        <div className="flex flex-col gap-4">
            <Button
                size="sm"
                variant="helper"
                className="w-full"
                disabled={!props.canEdit}
                onClick={() =>
                    props.onHideCommentsChangeAction(!props.hideComments?.value)
                }>
                <CardHeader className="flex flex-row items-center justify-between gap-6 p-4">
                    <div>
                        <div className="mb-2 flex flex-row items-center gap-2">
                            <Heading variant="h3">
                                Post as hidden comment
                                <span className="ml-1.5 inline-flex items-center rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-blue-700/10 ring-inset">
                                    GitHub only
                                </span>
                            </Heading>
                            <OverrideIndicator
                                currentValue={props.hideComments?.value}
                                initialState={props.initialState}
                                handleRevert={props.handleRevert}
                            />
                        </div>
                        <p className="text-text-secondary">
                            When enabled, all review messages will be posted as
                            hidden/minimized comments.
                        </p>
                    </div>
                    <Switch decorative checked={props.hideComments?.value} />
                </CardHeader>
            </Button>
        </div>
    );
};

import React, { useCallback } from "react";
import { Heading } from "@components/ui/heading";
import { CheckCircle2Icon, EditIcon, PlugIcon, TrashIcon } from "lucide-react";
import { Button } from "src/core/components/ui/button";
import { Card, CardFooter, CardHeader } from "src/core/components/ui/card";
import { INTEGRATIONS_KEY } from "src/core/enums";

type CardProps = {
    svg: React.ReactNode;
    title: string;
    isSetupComplete: boolean;
    disabled?: boolean;
    integrationKey: any;
    connectIntegration: (title: string, serviceType?: string) => void;
    editIntegration: (title: string) => void;
    deleteIntegration: (title: string) => void;
};

export default function CardConnection({
    isSetupComplete = false,
    disabled = false,
    svg,
    title,
    integrationKey,
    connectIntegration,
    editIntegration,
    deleteIntegration,
}: CardProps): React.ReactNode {
    const [buttonTopText, setButtonsTopText] = React.useState<string>("");
    const [isDisabled, setIsDisabled] = React.useState<boolean>(false);

    const getTopText = useCallback(
        (githubVerification: any) => {
            if (title.toLowerCase() === INTEGRATIONS_KEY.GITHUB) {
                if (githubVerification?.config?.status === "PENDING") {
                    return "Pending";
                } else if (
                    !githubVerification?.config?.hasRepositories &&
                    githubVerification?.hasConnection
                ) {
                    return "Add repositories";
                } else {
                    return "Connect";
                }
            } else {
                return "Connect";
            }
        },
        [title],
    );

    return (
        <Card>
            <CardHeader className="flex flex-row items-center gap-4">
                <span className="*:size-8!">{svg}</span>
                <Heading variant="h2">{title}</Heading>
            </CardHeader>

            <CardFooter className="flex flex-row items-end justify-between">
                {isSetupComplete ? (
                    <div className="text-success flex items-center gap-2 text-sm">
                        <CheckCircle2Icon className="size-5" />
                        <span>Connected</span>
                    </div>
                ) : (
                    <Button
                        size="md"
                        variant="primary"
                        onClick={() => connectIntegration(title)}
                        disabled={isSetupComplete}>
                        {buttonTopText}
                    </Button>
                )}

                {isSetupComplete && (
                    <div className="flex flex-col gap-2">
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={disabled || isDisabled}
                            leftIcon={
                                isSetupComplete ? <EditIcon /> : <PlugIcon />
                            }
                            onClick={() => editIntegration(title)}>
                            {isSetupComplete ? "Edit" : "Connect"}
                        </Button>
                        <Button
                            size="sm"
                            variant="tertiary"
                            className="text-danger"
                            disabled={disabled || isDisabled}
                            leftIcon={<TrashIcon />}
                            onClick={() => deleteIntegration(title)}>
                            Delete
                        </Button>
                    </div>
                )}
            </CardFooter>
        </Card>
    );
}

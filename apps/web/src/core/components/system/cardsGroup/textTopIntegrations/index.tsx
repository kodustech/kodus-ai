import React from "react";
import { Heading } from "@components/ui/heading";

const textTopObject = {
    codeManagement: {
        title: "Source code management",
        subTitle: "(Choose one)",
    },
};

const TextTopIntegrations = ({
    serviceType,
}: {
    serviceType: "codeManagement";
}): React.ReactNode => {
    const textObject = textTopObject[serviceType];
    return (
        <div className="mb-4 flex flex-col">
            <Heading variant="h2">{textObject.title}</Heading>
            <span className="text-text-secondary text-xs">
                {textObject.subTitle}
            </span>
        </div>
    );
};

export default TextTopIntegrations;

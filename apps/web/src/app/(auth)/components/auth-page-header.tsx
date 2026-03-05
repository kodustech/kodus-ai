import React from "react";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Page } from "@components/ui/page";

export default function AuthPageHeader({
    children,
}: {
    children?: React.ReactNode;
}) {
    return (
        <Page.Header className="flex w-full flex-col items-center gap-10">
            <SvgKodus className="h-8" />
            {children}
        </Page.Header>
    );
}

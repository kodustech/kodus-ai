import { PropsWithChildren } from "react";

// The organization pages are listed in the sidebar's Organization group.
export default async function Layout(props: PropsWithChildren) {
    return (
        <div className="flex flex-1 flex-row overflow-hidden">
            {props.children}
        </div>
    );
}

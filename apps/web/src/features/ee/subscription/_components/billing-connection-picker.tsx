"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { useBillingConnection } from "../_hooks/use-billing-connection";
import {
    readBillingConnectionId,
    selectBillingConnection,
} from "../_services/billing/billing-connection.client";

/** Picks the Git connection whose plan and seats the page shows. */
export const BillingConnectionPicker = () => {
    const router = useRouter();
    const { teamId, connections, connection } = useBillingConnection();
    const several = connections.length > 1;
    // The cookie is read while rendering, and a refresh does not re-render
    // this component: the choice shown is kept here.
    const [selected, setSelected] = useState(connection?.connectionId);

    // The server renders the cookie's connection; pin the first one so the
    // seats listed and the toggles always speak about the same connection.
    useEffect(() => {
        if (!several || !connection?.connectionId) return;
        if (readBillingConnectionId(teamId) !== connection.connectionId) {
            selectBillingConnection(teamId, connection.connectionId);
            router.refresh();
        }
    }, [several, teamId, connection?.connectionId, router]);

    if (!several) return null;

    return (
        <div className="mt-5 flex flex-col gap-1">
            <div className="flex items-center gap-3">
                <span className="text-sm font-medium">Git connection</span>
                <Select
                    value={selected ?? connection?.connectionId}
                    onValueChange={(connectionId) => {
                        setSelected(connectionId);
                        selectBillingConnection(teamId, connectionId);
                        router.refresh();
                    }}>
                    <SelectTrigger className="w-72">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {connections
                            .filter((c) => c.connectionId)
                            .map((c) => (
                                <SelectItem
                                    key={c.connectionId}
                                    value={c.connectionId!}>
                                    {c.connectionName || c.platformName}
                                    {c.connectionName
                                        ? ` (${c.platformName})`
                                        : ""}
                                </SelectItem>
                            ))}
                    </SelectContent>
                </Select>
            </div>
            <p className="text-text-secondary text-xs">
                {isSelfHosted
                    ? "Seats are assigned per connection and count toward the instance license."
                    : "Each Git connection has its own plan and seats. The trial and prepaid credits are shared by the workspace."}
            </p>
        </div>
    );
};

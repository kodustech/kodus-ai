"use client";

import { useEffect, useState } from "react";
import { greeting } from "src/core/utils/helpers";

/**
 * Time-of-day greeting, always computed against the READER's clock.
 *
 * `greeting()` reads `new Date().getHours()`, so calling it from a server
 * component gives the container's timezone: the Cockpit told a user in UTC-3
 * "Good afternoon" at 10am, and disagreed with the Issues tab beside it, which
 * is a client component and got it right. Going through one component keeps
 * every surface on the same answer whichever side of the boundary it sits on.
 *
 * Nothing is rendered until mount, so the server pass and the hydration pass
 * agree and React has no mismatch to resolve. Seeding state with the greeting
 * instead does NOT work: the server sends its own wording, the client's
 * initial state already holds the right one, and the effect then sets an
 * identical value — React bails out of the re-render and the server's wording
 * stays on screen for good.
 */
export const Greeting = ({ name }: { name?: string }) => {
    const [text, setText] = useState("");

    useEffect(() => {
        setText(greeting(name));
    }, [name]);

    return <>{text}</>;
};

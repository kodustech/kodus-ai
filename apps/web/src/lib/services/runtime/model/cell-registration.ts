// Connecting a cell of your own (docs/runtime/self-hosted.md): the org owner
// makes a single-use token here, valid 15 minutes and bound to where the
// cell runs, and runs the installer on the cell host. The commands never
// carry the token: it is pasted into a hidden prompt, so it stays out of the
// shell history and of anything the commands are copied into.

import type {
    CellRegistrationTokenState,
    CellTopology,
} from "@services/runtime/contracts";
import type { Tone } from "@services/runtime/labels";

export const CELL_TOPOLOGIES: {
    value: CellTopology;
    label: string;
    hint: string;
}[] = [
    {
        value: "self_hosted",
        label: "With Kodus self-hosted",
        hint: "Everything runs on your side, next to your Kodus installation. The installer on the server running Kodus wrote the host's bundle (runtime/state/cell-host/).",
    },
    {
        value: "hybrid",
        label: "In my cloud, with Kodus Cloud",
        hint: "The machines and your code stay in your cloud; Kodus Cloud decides what runs. Kodus gives you the hub's address and its CA.",
    },
];

/** A self-hosted install connects self-hosted cells; Kodus Cloud, cells in the customer's cloud. */
export const defaultCellTopology = (selfHosted: boolean): CellTopology =>
    selfHosted ? "self_hosted" : "hybrid";

/** The prompt the token is pasted into: hidden, kept in this shell's environment only. */
export const TOKEN_PROMPT =
    "read -rs KODUS_CELL_REGISTRATION_TOKEN && export KODUS_CELL_REGISTRATION_TOKEN";

export interface CellRegisterSteps {
    /** What has to be on the cell host before the commands. */
    before: string;
    commands: string[];
    after: string;
}

/**
 * What the operator runs on the cell host. No flag needs a value written by
 * hand for self-hosted: the bundle names the hub and its CA, the cell takes
 * the token's topology, and it picks its isolation backend and its
 * capacity from the host.
 */
export const cellRegisterSteps = (topology: CellTopology): CellRegisterSteps =>
    topology === "self_hosted"
        ? {
              before: "On the host, in a clone of kodus-installer, with runtime/state/cell-host/ copied from the server running Kodus to ./cell-host (privately: it holds the injector's OpenBao credential). Run the first line, paste the token (nothing shows), press Enter, then run the second.",
              commands: [
                  TOKEN_PROMPT,
                  "sudo -E scripts/runtime/cell-host.sh install --profile docker-gvisor --bundle ./cell-host",
              ],
              after: "The installer checks the host first and names anything missing (scripts/runtime/cell-host.sh check runs the same checks alone).",
          }
        : {
              before: "On the host, with the cell release installed and the hub's address and CA file from Kodus. Run the first line, paste the token (nothing shows), press Enter, then run the second.",
              commands: [
                  TOKEN_PROMPT,
                  "sudo -E cell register -hub https://<hub address from Kodus> -ca <hub CA file from Kodus>",
              ],
              after: "cell register writes the host's identity to /etc/kodus/cell; start the cell service with the same hub address.",
          };

const STATE: Record<CellRegistrationTokenState, { label: string; tone: Tone }> =
    {
        pending: { label: "Waiting for a host", tone: "info" },
        used: { label: "Used", tone: "success" },
        expired: { label: "Expired", tone: "neutral" },
        revoked: { label: "Revoked", tone: "warning" },
    };

export const cellTokenStateLabel = (s: CellRegistrationTokenState) =>
    STATE[s]?.label ?? s;
export const cellTokenStateTone = (s: CellRegistrationTokenState): Tone =>
    STATE[s]?.tone ?? "neutral";

export const cellTopologyLabel = (t: CellTopology) =>
    t === "self_hosted" ? "Self-hosted" : "Your cloud";

/** Only a pending token can be revoked: a used one made a cell, which is revoked as a cell. */
export const canRevokeCellToken = (s: CellRegistrationTokenState) =>
    s === "pending";

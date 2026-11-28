/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type {
    EnvironmentRepository,
    RuntimeEnvironment,
} from "@services/runtime/contracts";
import {
    useAddEnvironmentRepository,
    useRemoveEnvironmentRepository,
    useUpdateEnvironmentRepository,
} from "@services/runtime/queries";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { EnvironmentRepositories } from "./repositories";

jest.mock("@services/runtime/queries", () => ({
    useAddEnvironmentRepository: jest.fn(),
    useUpdateEnvironmentRepository: jest.fn(),
    useRemoveEnvironmentRepository: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("next/navigation", () => ({ usePathname: () => "/" }));
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
// Radix's select opens on pointer events jsdom does not have: a native one stands in.
jest.mock("@components/ui/select", () => ({
    Select: ({
        value,
        onValueChange,
        children,
    }: {
        value: string;
        onValueChange: (v: string) => void;
        children: ReactNode;
    }) => (
        <select
            aria-label="Repository"
            value={value}
            onChange={(e) => onValueChange(e.target.value)}>
            <option value="" />
            {children}
        </select>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({
        value,
        children,
    }: {
        value: string;
        children: ReactNode;
    }) => <option value={value}>{children}</option>,
}));

const mutation = () => ({
    mutate: jest.fn(),
    reset: jest.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null as unknown,
    variables: undefined as unknown,
});
let add = mutation();
let update = mutation();
let remove = mutation();

beforeAll(() => {
    if (!("ResizeObserver" in globalThis))
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
});
beforeEach(() => {
    add = mutation();
    update = mutation();
    remove = mutation();
    (useAddEnvironmentRepository as jest.Mock).mockImplementation(() => add);
    (useUpdateEnvironmentRepository as jest.Mock).mockImplementation(
        () => update,
    );
    (useRemoveEnvironmentRepository as jest.Mock).mockImplementation(
        () => remove,
    );
});

const repo = (
    repositoryId: string,
    fullName: string,
    role: EnvironmentRepository["role"],
    patch: Partial<EnvironmentRepository> = {},
): EnvironmentRepository => ({
    repositoryId,
    repositoryName: fullName,
    fullName,
    alias: fullName.split("/")[1],
    role,
    triggers: true,
    pairBranches: false,
    ...patch,
});

const platform: RuntimeEnvironment = {
    environmentId: "env-1",
    repositoryId: "r-app",
    repositoryName: "acme/app",
    repositories: [
        repo("r-app", "acme/app", "primary", {
            lastSetupSha: "a1b2c3d".padEnd(40, "0"),
        }),
        repo("r-billing", "acme/billing", "member", {
            alias: "billing",
            pairBranches: true,
            lastSetupSha: "9f8e7d6".padEnd(40, "0"),
        }),
        repo("r-auth", "acme/auth-service", "member", {
            alias: "auth",
            triggers: false,
        }),
    ],
};
const checkout: RuntimeEnvironment = {
    environmentId: "env-2",
    repositoryId: "r-shop",
    repositoryName: "acme/storefront",
    repositories: [
        repo("r-shop", "acme/storefront", "primary"),
        repo("r-auth", "acme/auth-service", "member"),
        repo("r-worker", "acme/worker", "member"),
    ],
};
const connected = [
    { repositoryId: "r-app", repositoryName: "acme/app" },
    { repositoryId: "r-worker", repositoryName: "acme/worker" },
    { repositoryId: "r-tokens", repositoryName: "acme/design-tokens" },
];

const view = (canManage = true, env = platform) =>
    render(
        <EnvironmentRepositories
            env={env}
            environments={[platform, checkout]}
            connected={connected}
            canManage={canManage}
        />,
    );

const rows = () =>
    within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row");

describe("the Repositories section", () => {
    it("lists every repository, the primary first, with its folder, switches and last setup commit", () => {
        view();
        const [app, billing, auth] = rows();
        expect(app).toHaveTextContent("acme/app");
        expect(app).toHaveTextContent("ws/app");
        expect(app).toHaveTextContent("a1b2c3d");
        expect(
            within(app).queryByRole("button", { name: /Remove/ }),
        ).toBeNull();
        expect(billing).toHaveTextContent("ws/billing");
        expect(
            screen.getByRole("switch", {
                name: "Pair branches of billing with the same name",
            }),
        ).toBeChecked();
        // The other system it is part of is named on its row.
        expect(auth).toHaveTextContent("storefront");
        expect(
            screen.getByRole("switch", {
                name: "Run pull requests of auth-service in this environment",
            }),
        ).not.toBeChecked();
    });

    it("changes whether a repository's PRs start Runs here, and pairs branches", () => {
        view();
        fireEvent.click(
            screen.getByRole("switch", {
                name: "Run pull requests of auth-service in this environment",
            }),
        );
        expect(update.mutate).toHaveBeenCalledWith({
            environmentId: "env-1",
            repositoryId: "r-auth",
            triggers: true,
        });
        fireEvent.click(
            screen.getByRole("switch", {
                name: "Pair branches of billing with the same name",
            }),
        );
        expect(update.mutate).toHaveBeenLastCalledWith({
            environmentId: "env-1",
            repositoryId: "r-billing",
            pairBranches: false,
        });
    });

    it("shows a refused change on its row", () => {
        update.isError = true;
        update.error = {
            statusCode: 409,
            body: {
                message:
                    "Another repository of this environment has that alias",
            },
        };
        view();
        expect(screen.getAllByRole("alert")[0]).toHaveTextContent(
            "Another repository of this environment has that alias",
        );
    });

    it("lets only the owner change the repositories", () => {
        view(false);
        expect(
            screen.getByRole("button", { name: "Add repository" }),
        ).toBeDisabled();
        for (const s of screen.getAllByRole("switch")) expect(s).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Remove billing" }),
        ).toBeDisabled();
    });

    it("removes a member only after an in-app confirmation", () => {
        view();
        fireEvent.click(screen.getByRole("button", { name: "Remove billing" }));
        const dialog = screen.getByRole("dialog");
        expect(dialog).toHaveTextContent("billing");
        expect(remove.mutate).not.toHaveBeenCalled();
        fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
        expect(remove.mutate).toHaveBeenCalledWith(
            { environmentId: "env-1", repositoryId: "r-billing" },
            expect.any(Object),
        );
    });

    it("keeps a refused removal in the dialog", () => {
        remove.isError = true;
        remove.error = {
            statusCode: 409,
            body: {
                message:
                    "The primary repository leaves only with its environment",
            },
        };
        view();
        fireEvent.click(screen.getByRole("button", { name: "Remove billing" }));
        expect(
            within(screen.getByRole("dialog")).getByRole("alert"),
        ).toHaveTextContent(
            "The primary repository leaves only with its environment",
        );
    });
});

describe("Add a repository", () => {
    const open = () => {
        view();
        fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
        return screen.getByRole("dialog");
    };

    it("offers only connected repositories not in the environment, saying where else they are", () => {
        const dialog = open();
        const options = within(dialog)
            .getAllByRole("option")
            .map((o) => o.textContent)
            .filter(Boolean);
        expect(options).toEqual([
            "acme/design-tokens",
            "acme/worker · also in storefront",
        ]);
        expect(dialog).toHaveTextContent("Add a repository to app");
        expect(dialog).toHaveTextContent(
            "It boots with acme/app, acme/billing and acme/auth-service in every Run",
        );
        expect(dialog).toHaveTextContent(
            /Runs keep using the last good setup until the new one boots/,
        );
        expect(
            within(dialog).getByRole("link", {
                name: /Connect it in the Git settings/,
            }),
        ).toHaveAttribute("href", "/settings/git/repositories");
    });

    it("prefills the folder, starts a repository of another system with its PRs off, and sends the choice", () => {
        const dialog = open();
        fireEvent.change(
            within(dialog).getByRole("combobox", { name: "Repository" }),
            {
                target: { value: "r-worker" },
            },
        );
        expect(
            within(dialog).getByRole("textbox", { name: "Folder" }),
        ).toHaveValue("worker");
        expect(
            within(dialog).getByRole("switch", {
                name: "Run its pull requests here",
            }),
        ).not.toBeChecked();
        expect(dialog).toHaveTextContent(
            /each of its pull requests starts one more Run/,
        );
        fireEvent.click(
            within(dialog).getByRole("switch", {
                name: "Pair branches with the same name",
            }),
        );
        fireEvent.click(
            within(dialog).getByRole("button", { name: "Add and set up" }),
        );
        expect(add.mutate).toHaveBeenCalledWith(
            {
                environmentId: "env-1",
                repositoryId: "r-worker",
                triggers: false,
                pairBranches: true,
            },
            expect.any(Object),
        );
    });

    it("sends a folder changed by hand, and refuses one another repository has", () => {
        const dialog = open();
        fireEvent.change(
            within(dialog).getByRole("combobox", { name: "Repository" }),
            {
                target: { value: "r-tokens" },
            },
        );
        const folder = within(dialog).getByRole("textbox", { name: "Folder" });
        fireEvent.change(folder, { target: { value: "billing" } });
        expect(folder).toHaveAttribute("aria-invalid", "true");
        expect(
            within(dialog).getByRole("button", { name: "Add and set up" }),
        ).toBeDisabled();
        fireEvent.change(folder, { target: { value: "tokens" } });
        fireEvent.click(
            within(dialog).getByRole("button", { name: "Add and set up" }),
        );
        expect(add.mutate).toHaveBeenCalledWith(
            expect.objectContaining({
                repositoryId: "r-tokens",
                alias: "tokens",
                triggers: true,
            }),
            expect.any(Object),
        );
    });

    it("asks for a repository before sending, and shows the API's refusal inline", () => {
        add.isError = true;
        add.error = {
            statusCode: 409,
            body: { message: "An environment holds at most 10 repositories" },
        };
        const dialog = open();
        fireEvent.click(
            within(dialog).getByRole("button", { name: "Add and set up" }),
        );
        expect(add.mutate).not.toHaveBeenCalled();
        expect(dialog).toHaveTextContent(
            "An environment holds at most 10 repositories",
        );
    });

    it("is closed to a full environment", () => {
        const many = Array.from({ length: 9 }, (_, i) =>
            repo(`m${i}`, `acme/m${i}`, "member"),
        );
        view(true, {
            ...platform,
            repositories: [repo("r-app", "acme/app", "primary"), ...many],
        });
        expect(
            screen.getByRole("button", { name: "Add repository" }),
        ).toBeDisabled();
    });
});

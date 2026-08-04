/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

import type { BYOKConfig } from "../_types";
import {
    DeleteRejectionAlert,
    deleteConfirmCopy,
    isLastModel,
    parseRejectionReasons,
    useDeleteModel,
} from "./delete-model-flow";

// ── module mocks ──────────────────────────────────────────────────────────────
// The flow calls deleteBYOK (the v2 { modelId } route from 04-07) and toasts only
// on the network/unknown branch. Stub the service so the spec never hits the
// network, and capture toast calls to assert the toast-vs-persistent-Alert split.
const deleteBYOK = jest.fn();
jest.mock("@services/organizationParameters/fetch", () => ({
    deleteBYOK: (...args: unknown[]) => deleteBYOK(...args),
}));

const toast = jest.fn();
jest.mock("@components/ui/toaster/use-toast", () => ({
    toast: (...args: unknown[]) => toast(...args),
}));

// confirmAndDelete opens a ConfirmModal via magicModal.show(factory). Rather than
// render the portal, capture the factory's element props so the spec can assert
// the chosen copy and drive onConfirm directly.
const modalState: { props?: Record<string, any> } = {};
jest.mock("@components/ui/magic-modal", () => ({
    magicModal: {
        show: (factory: () => { props: Record<string, any> }) => {
            modalState.props = factory().props;
        },
        hide: jest.fn(),
    },
}));

beforeEach(() => {
    deleteBYOK.mockReset();
    toast.mockReset();
    modalState.props = undefined;
});

// ── fixtures ──────────────────────────────────────────────────────────────────
const twoModelConfig: BYOKConfig = {
    version: 2,
    credentials: [{ id: "c1", provider: "openai", apiKey: "••••" }],
    models: [
        { id: "m1", credentialId: "c1", model: "test-model-alpha" },
        { id: "m2", credentialId: "c1", model: "test-model-beta" },
    ],
};

const oneModelConfig: BYOKConfig = {
    version: 2,
    credentials: [{ id: "c1", provider: "openai", apiKey: "••••" }],
    models: [{ id: "m1", credentialId: "c1", model: "test-model-alpha" }],
};

const managedPlusOneConfig: BYOKConfig = {
    version: 2,
    credentials: [
        { id: "c1", provider: "openai", apiKey: "••••" },
        { id: "cm", provider: "google_gemini", managed: true },
    ],
    models: [
        { id: "m1", credentialId: "c1", model: "test-model-alpha" },
        { id: "mm", credentialId: "cm", model: "managed-default" },
    ],
};

const modelAlpha = twoModelConfig.models[0];

// The REAL backend envelope: DeleteByokConfigUseCase throws ONE joined string
// (delete-byok-config.use-case.ts:174) carrying the model ID and the usages
// joined with "; " — NOT an array. This fixture mimics that single-string shape.
const REJECTION_REFS = [
    "routing default",
    'repository "api-core" (byokModelId)',
    'repository "web-app" (byokModelId)',
    'directory "src" in repository "api-core" (byokModelId)',
    "task override codeReview",
    "task override prSummary",
    "global override (byokModelId)",
    'repository "docs" (byokModel)',
];

const inUseError = {
    response: {
        data: {
            statusCode: 400,
            error: "Bad Request",
            message:
                `Model "m1" is in use and cannot be deleted. ` +
                `Remove these references first: ${REJECTION_REFS.join("; ")}.`,
        },
    },
};

// ── parseRejectionReasons ─────────────────────────────────────────────────────
describe("parseRejectionReasons", () => {
    it("splits the single joined backend string into the FULL reason list", () => {
        const reasons = parseRejectionReasons(inUseError);
        expect(reasons).toEqual(REJECTION_REFS);
        expect(reasons).toHaveLength(8);
    });

    it("returns [] for a network error (no structured reason)", () => {
        expect(parseRejectionReasons(new Error("Network Error"))).toEqual([]);
        expect(parseRejectionReasons(undefined)).toEqual([]);
    });

    it("returns [] for a 400 without the references marker", () => {
        expect(
            parseRejectionReasons({
                response: { data: { message: "Some other bad request" } },
            }),
        ).toEqual([]);
    });
});

// ── isLastModel ───────────────────────────────────────────────────────────────
describe("isLastModel", () => {
    it("is true when exactly one non-managed model remains", () => {
        expect(isLastModel(oneModelConfig, "m1")).toBe(true);
    });

    it("is false when more than one non-managed model exists", () => {
        expect(isLastModel(twoModelConfig, "m1")).toBe(false);
    });

    it("excludes managed credentials from the count", () => {
        // One BYOK model + one managed model ⇒ deleting the BYOK model is last.
        expect(isLastModel(managedPlusOneConfig, "m1")).toBe(true);
    });
});

// ── deleteConfirmCopy ─────────────────────────────────────────────────────────
describe("deleteConfirmCopy", () => {
    it("uses the plain remove copy when not the last model", () => {
        const copy = deleteConfirmCopy(false, "test-model-alpha");
        expect(copy.title).toBe("Remove test-model-alpha?");
        expect(copy.description).toBe(
            "Kodus will stop using this model immediately.",
        );
        expect(copy.confirmText).toBe("Remove");
    });

    it("uses the distinct disconnect copy for the last model", () => {
        const copy = deleteConfirmCopy(true, "test-model-alpha");
        expect(copy.title).toBe("Disconnect BYOK entirely?");
        expect(copy.description).toContain("only connected model");
        expect(copy.description).toContain("environment-configured LLM");
        expect(copy.confirmText).toBe("Disconnect");
    });
});

// ── DeleteRejectionAlert (cap) ────────────────────────────────────────────────
describe("DeleteRejectionAlert", () => {
    it("caps the list at 6 and shows the remainder count for >6 reasons", () => {
        render(
            <DeleteRejectionAlert
                modelName="test-model-alpha"
                reasons={REJECTION_REFS}
            />,
        );
        // First 6 rendered.
        expect(screen.getByText("routing default")).toBeInTheDocument();
        expect(
            screen.getByText("task override prSummary"),
        ).toBeInTheDocument();
        // 7th/8th collapsed into the remainder line.
        expect(
            screen.queryByText("global override (byokModelId)"),
        ).not.toBeInTheDocument();
        expect(screen.getByText("…and 2 more")).toBeInTheDocument();
    });

    it("renders nothing when there are no reasons", () => {
        const { container } = render(
            <DeleteRejectionAlert modelName="x" reasons={[]} />,
        );
        expect(container).toBeEmptyDOMElement();
    });
});

// ── useDeleteModel (the four behaviors) ───────────────────────────────────────
function Harness({
    config,
    model,
    onDeleted,
}: {
    config: BYOKConfig;
    model: BYOKConfig["models"][number];
    onDeleted: () => void;
}) {
    const { confirmAndDelete, rejectionReasons } = useDeleteModel({
        config,
        model,
        onDeleted,
    });
    return (
        <div>
            <button onClick={confirmAndDelete}>trigger</button>
            <DeleteRejectionAlert
                modelName={model.model}
                reasons={rejectionReasons}
            />
        </div>
    );
}

const confirmDelete = async () => {
    await act(async () => {
        fireEvent.click(screen.getByText("trigger"));
    });
    await act(async () => {
        await modalState.props?.onConfirm();
    });
};

describe("useDeleteModel", () => {
    it("clean delete: resolves → onDeleted fires, no alert, no toast", async () => {
        deleteBYOK.mockResolvedValue(undefined);
        const onDeleted = jest.fn();
        render(
            <Harness
                config={twoModelConfig}
                model={modelAlpha}
                onDeleted={onDeleted}
            />,
        );
        await confirmDelete();
        expect(deleteBYOK).toHaveBeenCalledWith({ modelId: "m1" });
        expect(onDeleted).toHaveBeenCalledTimes(1);
        expect(toast).not.toHaveBeenCalled();
        expect(screen.queryByText("…and 2 more")).not.toBeInTheDocument();
    });

    it("in-use 400: surfaces the capped reason list in a persistent Alert, no toast", async () => {
        deleteBYOK.mockRejectedValue(inUseError);
        const onDeleted = jest.fn();
        render(
            <Harness
                config={twoModelConfig}
                model={modelAlpha}
                onDeleted={onDeleted}
            />,
        );
        await confirmDelete();
        expect(onDeleted).not.toHaveBeenCalled();
        expect(toast).not.toHaveBeenCalled();
        expect(screen.getByText("routing default")).toBeInTheDocument();
        expect(screen.getByText("…and 2 more")).toBeInTheDocument();
    });

    it("network error: toasts and leaves the reason list empty", async () => {
        deleteBYOK.mockRejectedValue(new Error("Network Error"));
        const onDeleted = jest.fn();
        render(
            <Harness
                config={twoModelConfig}
                model={modelAlpha}
                onDeleted={onDeleted}
            />,
        );
        await confirmDelete();
        expect(onDeleted).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({ variant: "danger" }),
        );
        expect(screen.queryByText("…and 2 more")).not.toBeInTheDocument();
    });

    it("last model: the confirm modal uses the disconnect copy", async () => {
        deleteBYOK.mockResolvedValue(undefined);
        render(
            <Harness
                config={oneModelConfig}
                model={oneModelConfig.models[0]}
                onDeleted={jest.fn()}
            />,
        );
        await act(async () => {
            fireEvent.click(screen.getByText("trigger"));
        });
        expect(modalState.props?.title).toBe("Disconnect BYOK entirely?");
        expect(modalState.props?.confirmText).toBe("Disconnect");
    });
});

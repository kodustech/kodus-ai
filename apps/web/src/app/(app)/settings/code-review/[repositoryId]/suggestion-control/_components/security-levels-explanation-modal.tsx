import {
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { magicModal } from "@components/ui/magic-modal";
import { Section } from "@components/ui/section";
import { Dialog } from "@radix-ui/react-dialog";
import { cn } from "src/core/utils/components";

const SeverityLevelsBadge = ({ className }: { className: string }) => (
    <div className={cn("size-3 rounded-full", className)} />
);

export const SeverityLevelsExplanationModal = () => {
    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Severity levels</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4 overflow-y-auto text-sm *:gap-0.5">
                    <Section.Root>
                        <Section.Header className="justify-start gap-2">
                            <SeverityLevelsBadge className="bg-[var(--color-info)]" />
                            <Section.Title>Low Level</Section.Title>
                        </Section.Header>

                        <Section.Content>
                            Minor enhancements that would improve code quality.
                            These represent small optimizations, style
                            improvements, or subtle refinements that would
                            incrementally better the codebase.
                        </Section.Content>
                    </Section.Root>

                    <Section.Root>
                        <Section.Header className="justify-start gap-2">
                            <SeverityLevelsBadge className="bg-[var(--color-alert)]" />
                            <Section.Title>Medium Level</Section.Title>
                        </Section.Header>

                        <Section.Content>
                            Moderate improvements recommended but not
                            immediately critical. These suggestions focus on
                            enhancing code quality, following best practices,
                            and preventing future technical debt.
                        </Section.Content>
                    </Section.Root>

                    <Section.Root>
                        <Section.Header className="justify-start gap-2">
                            <SeverityLevelsBadge className="bg-[var(--color-warning)]" />
                            <Section.Title>High Level</Section.Title>
                        </Section.Header>

                        <Section.Content>
                            Significant issues that should be addressed in the
                            near term. These represent important improvements
                            needed in code quality, potential risks, or
                            substantial technical improvements that would
                            notably enhance the codebase.
                        </Section.Content>
                    </Section.Root>

                    <Section.Root>
                        <Section.Header className="justify-start gap-2">
                            <SeverityLevelsBadge className="bg-[var(--color-danger)]" />
                            <Section.Title>Critical Level</Section.Title>
                        </Section.Header>

                        <Section.Content>
                            Issues that require immediate attention and could
                            severely impact system stability, security, or
                            functionality. These problems typically represent
                            high-risk scenarios that could lead to system
                            failures, vulnerabilities, or significant technical
                            debt.
                        </Section.Content>
                    </Section.Root>
                </div>
            </DialogContent>
        </Dialog>
    );
};

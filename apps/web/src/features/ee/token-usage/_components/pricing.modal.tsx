import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import { magicModal } from "@components/ui/magic-modal";
import { ContinuousSlider } from "@components/ui/slider";
import { ModelPricingInfo } from "@services/usage/types";

import { M } from "../_lib/constants";

export const TokenPricingModal = ({
    pricing,
    onPricingChange,
}: {
    pricing: Record<string, ModelPricingInfo>;
    onPricingChange: (newPricing: Record<string, ModelPricingInfo>) => void;
}) => {
    const [localPrices, setLocalPrices] = useState(pricing);

    const handleApplyChange = () => {
        onPricingChange(localPrices);
        magicModal.hide();
    };

    const handleSliderChange = (
        model: string,
        type: keyof ModelPricingInfo["pricing"],
        value: number,
    ) => {
        setLocalPrices((prev) => ({
            ...prev,
            [model]: {
                ...prev[model],
                pricing: {
                    ...prev[model].pricing,
                    [type]: value,
                },
            },
        }));
    };

    if (!localPrices) {
        return null;
    }

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Edit Model Pricing</DialogTitle>
                    <DialogDescription>
                        Adjust the cost per 1 million tokens for your models.
                    </DialogDescription>
                </DialogHeader>
                <div className="max-h-[80vh] space-y-6 overflow-y-auto py-4">
                    {Object.entries(localPrices).map(
                        ([model, modelPricing]) => {
                            if (!modelPricing || !modelPricing.pricing) {
                                return null;
                            }

                            return (
                                <Card key={model}>
                                    <CardHeader>
                                        <CardTitle>{model}</CardTitle>
                                        <CardDescription>
                                            Model ID: {modelPricing.id}
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="grid gap-4">
                                            <PricingInput
                                                label="Prompt Token Price ($/1M)"
                                                value={
                                                    modelPricing.pricing.prompt
                                                }
                                                onValueChange={(val) =>
                                                    handleSliderChange(
                                                        model,
                                                        "prompt",
                                                        val,
                                                    )
                                                }
                                            />
                                            <PricingInput
                                                label="Completion Token Price ($/1M)"
                                                value={
                                                    modelPricing.pricing
                                                        .completion
                                                }
                                                onValueChange={(val) =>
                                                    handleSliderChange(
                                                        model,
                                                        "completion",
                                                        val,
                                                    )
                                                }
                                            />
                                            <PricingInput
                                                label="Internal Reasoning Token Price ($/1M)"
                                                value={
                                                    modelPricing.pricing
                                                        .internal_reasoning
                                                }
                                                onValueChange={(val) =>
                                                    handleSliderChange(
                                                        model,
                                                        "internal_reasoning",
                                                        val,
                                                    )
                                                }
                                            />
                                        </div>
                                    </CardContent>
                                </Card>
                            );
                        },
                    )}
                </div>
                <DialogFooter>
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={() => magicModal.hide()}>
                        Cancel
                    </Button>
                    <Button
                        size="md"
                        variant="primary"
                        onClick={handleApplyChange}>
                        Apply Changes
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

const PricingInput = ({
    label,
    value,
    onValueChange,
}: {
    label: string;
    value: number;
    onValueChange: (value: number) => void;
}) => (
    <div className="grid gap-2">
        <Label>{label}</Label>
        <div className="flex items-center gap-4">
            <ContinuousSlider
                min={0}
                max={50}
                step={0.01}
                value={value * M}
                onValueChange={(val) => onValueChange(val / M)}
            />
            <Input
                type="number"
                className="w-24"
                value={(value * M).toFixed(2)}
                onChange={(e) =>
                    onValueChange(parseFloat(e.target.value) / M || 0)
                }
            />
        </div>
    </div>
);

import { RadioGroup } from "@radix-ui/themes";
import { NewItemsFrom } from "@services/metrics/types";
import { cn } from "src/core/utils/components";

interface IDeliveryCapacityFilterProps {
    newItemsFrom: NewItemsFrom;
    handleFilterDeliverCapacityMetric: (value: NewItemsFrom) => Promise<void>;
}

export function DeliveryCapacityFilter({
    newItemsFrom,
    handleFilterDeliverCapacityMetric,
}: IDeliveryCapacityFilterProps) {
    return (
        <div className="flex flex-col gap-6">
            <RadioGroup.Root
                value={newItemsFrom}
                onValueChange={handleFilterDeliverCapacityMetric}>
                <div className="flex flex-row gap-2">
                    <RadioGroup.Item
                        value={NewItemsFrom.TODO_COLUMN}
                        className={cn(
                            "flex w-64 cursor-pointer flex-col justify-between rounded-xl border border-[#6A57A433] bg-[#292031] p-4 transition-colors hover:border-[#6A57A4] hover:bg-[#382A41]",
                            newItemsFrom === NewItemsFrom.TODO_COLUMN &&
                                "rounded-xl border-[#6A57A4] bg-[#382A41]",
                        )}>
                        <div>
                            <h3 className="text-sm font-bold">To do</h3>
                            <span className="text-xs text-gray-400">
                                Count "new items" as items added to the "To do"
                                column.
                            </span>
                        </div>
                    </RadioGroup.Item>
                    <RadioGroup.Item
                        value={NewItemsFrom.CREATION_DATE}
                        className={cn(
                            "flex w-64 cursor-pointer flex-col justify-between rounded-xl border border-[#6A57A433] bg-[#292031] p-4 transition-colors hover:border-[#6A57A4] hover:bg-[#382A41]",
                            newItemsFrom === NewItemsFrom.TODO_COLUMN &&
                                "rounded-xl border-[#6A57A4] bg-[#382A41]",
                        )}>
                        <div>
                            <h3 className="text-sm font-bold">Creation date</h3>
                            <span className="text-xs text-gray-400">
                                Filter "new items" by creation date.
                            </span>
                        </div>
                    </RadioGroup.Item>
                </div>
            </RadioGroup.Root>
        </div>
    );
}

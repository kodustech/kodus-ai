export function createOptimizedBatches<T>(
    items: T[],
    options?: {
        minBatchSize?: number;
        maxBatchSize?: number;
    },
): T[][] {
    const totalItems = items.length;
    const minBatchSize = options?.minBatchSize ?? 20;
    const maxBatchSize = options?.maxBatchSize ?? 30;

    let numBatches = 1;
    let batchSize = totalItems;

    if (totalItems > minBatchSize) {
        numBatches = Math.ceil(totalItems / minBatchSize);
        batchSize = Math.ceil(totalItems / numBatches);

        if (batchSize > maxBatchSize) {
            numBatches = Math.ceil(totalItems / maxBatchSize);
            batchSize = Math.ceil(totalItems / numBatches);
        }
    }

    const batches: T[][] = [];
    for (let i = 0; i < totalItems; i += batchSize) {
        batches.push(items.slice(i, i + batchSize));
    }

    return batches;
}

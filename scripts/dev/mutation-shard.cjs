#!/usr/bin/env node
// Keep every range of a file in one shard so aggregate reports never count a
// mutant twice. Changed-line counts approximate the amount of work per file.
const fs = require('node:fs');

const index = Number(process.argv[2]);
const count = Number(process.argv[3]);
const selectors = process.argv.slice(4);
if (
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    count < 1 ||
    index < 0 ||
    index >= count
) {
    throw new Error('Invalid mutation shard index/count');
}

const groups = new Map();
for (const selector of selectors) {
    const range = selector.match(/^(.*):(\d+)-(\d+)$/);
    const file = range ? range[1] : selector;
    const weight = range
        ? Number(range[3]) - Number(range[2]) + 1
        : Math.max(
              1,
              fs.existsSync(file)
                  ? fs.readFileSync(file, 'utf8').split('\n').length
                  : 50,
          );
    const group = groups.get(file) || { file, selectors: [], weight: 0 };
    group.selectors.push(selector);
    group.weight += weight;
    groups.set(file, group);
}

const shards = Array.from({ length: count }, () => ({
    weight: 0,
    selectors: [],
}));
for (const group of [...groups.values()].sort(
    (a, b) => b.weight - a.weight || a.file.localeCompare(b.file),
)) {
    const target = shards.reduce(
        (best, shard, shardIndex) =>
            shard.weight < shards[best].weight ? shardIndex : best,
        0,
    );
    shards[target].weight += group.weight;
    shards[target].selectors.push(...group.selectors);
}

process.stdout.write(shards[index].selectors.join(','));

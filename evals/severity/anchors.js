#!/usr/bin/env node
/**
 * Real gold-v3 problems outside the dataset, 4 per level (low, medium, high),
 * one per category first,
 * as calibration examples for the severity prompt. None of them is scored.
 *
 *   node evals/severity/anchors.js  ->  evals/severity/dataset/anchors.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const V3 = path.join(__dirname, '../dedup/gold-v3');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const flat = (f) => { const x = read(f); return Array.isArray(x) ? x : Object.values(x.prs).flat(); };
const rand = (s) => parseInt(crypto.createHash('sha256').update(`severity-anchors|${s}`).digest('hex').slice(0, 12), 16);
const inSet = new Set(read(path.join(__dirname, 'dataset/items.json')).items.map((x) => x.issueId));
const real = [...flat(`${V3}/golden.json`), ...flat(`${V3}/fps-conhecidos.json`)].filter((x) => x.class === 'TP' && !inSet.has(x.issueId));
const anchors = [];
for (const level of ['low', 'medium', 'high']) {
    const pool = real.filter((x) => x.severity === level && (x.commentOpus || x.comment)).sort((a, b) => rand(a.issueId) - rand(b.issueId));
    // One per category first, so the examples are not four of a kind.
    const seen = new Set();
    const pick = [...pool.filter((x) => !seen.has(x.category) && seen.add(x.category)), ...pool].filter((x, i, a) => a.indexOf(x) === i).slice(0, 4);
    for (const x of pick) anchors.push({ issueId: x.issueId, severity: level, text: (x.commentOpus || x.comment).replace(/\s+/g, ' ').trim() });
}
fs.writeFileSync(path.join(__dirname, 'dataset/anchors.json'), JSON.stringify({ anchors }, null, 1));
for (const a of anchors) console.log(a.severity.padEnd(7), a.text.slice(0, 150));

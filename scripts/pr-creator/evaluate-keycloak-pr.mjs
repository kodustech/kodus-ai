import fs from 'fs';
import fsPromises from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import dotenv from 'dotenv';

const envPath = path.resolve(process.cwd(), '../../.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
dotenv.config();

const GOOGLE_API_KEY = process.env.API_GOOGLE_AI_API_KEY;

async function callGemini(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${GOOGLE_API_KEY}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
        })
    });
    if (!res.ok) throw new Error(`Gemini API Error: ${await res.text()}`);
    return JSON.parse((await res.json()).candidates[0].content.parts[0].text);
}

async function main() {
    const prsData = JSON.parse(await fsPromises.readFile('prs.json', 'utf-8'));
    const goldenMap = {};
    for (const item of prsData.prs) {
        if (!goldenMap[item.repo]) goldenMap[item.repo] = {};
        goldenMap[item.repo][item.head] = item.golden_comments;
    }

    const repo = 'Wellington01/keycloak-greptile';
    const prNumber = 88;
    const headBranch = 'feature-idp-cache-implementation';
    
    console.log(`\n🔍 Buscando comentários no PR #${prNumber} em ${repo}...`);

    let reviewComments = [];
    let issueComments = [];
    try {
        reviewComments = JSON.parse(execSync(`gh api repos/${repo}/pulls/${prNumber}/comments`, { encoding: 'utf-8' }));
        issueComments = JSON.parse(execSync(`gh api repos/${repo}/issues/${prNumber}/comments`, { encoding: 'utf-8' }));
    } catch (err) {
        console.log(`   ❌ Erro ao buscar comentários.`);
        process.exit(1);
    }

    const actualComments = [
        ...reviewComments.map(c => `[LINHA ${c.line || 'GERAL'}] ${c.body}`),
        ...issueComments.map(c => `[GERAL] ${c.body}`)
    ];

    if (actualComments.length === 0) {
        console.log(`   -> ⏳ Nenhum comentário encontrado. Kodus travou ou ainda está pensando.`);
        process.exit(0);
    }

    const goldenComments = goldenMap[repo][headBranch];
    const allCommentsText = actualComments.join('\n\n--- PRÓXIMO COMENTÁRIO ---\n\n');
    let prCovered = 0;
    
    console.log(`\n✅ AVALIAÇÃO DO PR #${prNumber}`);

    for (const golden of goldenComments) {
        console.log(`   🔸 Esperado (${golden.severity}): ${golden.comment}`);
        const prompt = `You are an expert software engineering judge evaluating an AI Code Review tool.
Target Bug: "${golden.comment}"
Actual AI Review Comments: """${allCommentsText}"""

Did the AI reviewer find this bug? 
Consider it "found" (true) IF:
1. The AI points out the same conceptual flaw or bug.
2. The AI highlights the correct problematic code and suggests a fix that would resolve the core issue mentioned in the Golden Comment, even if explained differently.
3. The AI is warning about the same failure mode/crash/vulnerability.
Respond ONLY with a valid JSON object in the following format:
{"found": boolean, "reason": "Quote the actual AI comment if it was found."}`;

        try {
            const evaluation = await callGemini(prompt);
            if (evaluation.found) {
                console.log(`      🟢 ENCONTRADO!`);
                console.log(`      📝 Motivo: ${evaluation.reason}`);
                prCovered++;
            } else {
                console.log(`      🔴 FALSO NEGATIVO.`);
                console.log(`      📝 Motivo: ${evaluation.reason}`);
            }
        } catch (e) {}
    }
    console.log(`\n   📊 Assertividade neste PR: ${prCovered}/${goldenComments.length} (${Math.round((prCovered/goldenComments.length)*100)}%)`);
}
main();

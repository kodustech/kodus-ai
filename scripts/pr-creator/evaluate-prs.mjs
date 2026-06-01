import fs from 'fs';
import fsPromises from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import dotenv from 'dotenv';

const envPath = path.resolve(process.cwd(), '../../.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
dotenv.config();

const GOOGLE_API_KEY = process.env.API_GOOGLE_AI_API_KEY;

if (!GOOGLE_API_KEY) {
    console.error("ERRO: É necessário exportar a variável de ambiente API_GOOGLE_AI_API_KEY para rodar a avaliação com Gemini.");
    process.exit(1);
}

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
    console.log("==================================================");
    console.log("📊 KODUS AI - AVALIAÇÃO DE ASSERTIVIDADE DOS PRS");
    console.log("==================================================\n");

    const prsData = JSON.parse(await fsPromises.readFile('prs.json', 'utf-8'));
    const goldenMap = {};
    for (const item of prsData.prs) {
        if (!goldenMap[item.repo]) goldenMap[item.repo] = {};
        goldenMap[item.repo][item.head] = item.golden_comments;
    }

    const repos = [
        'Wellington01/sentry-greptile',
        'Wellington01/grafana-greptile',
        'Wellington01/discourse-greptile',
        'Wellington01/cal.com-greptile',
        'Wellington01/keycloak-greptile'
    ];

    let totalGolden = 0;
    let totalCovered = 0;
    const statsByRepo = {};

    for (const repo of repos) {
        console.log(`\n🔍 Verificando PRs finalizados em ${repo}...`);
        statsByRepo[repo] = { golden: 0, covered: 0 };
        
        let openPrs = [];
        try {
            openPrs = JSON.parse(execSync(`gh api repos/${repo}/pulls?state=open`, { encoding: 'utf-8' }));
        } catch (err) {
            console.log(`   ❌ Erro ao buscar PRs.`);
            continue;
        }

        if (openPrs.length === 0) {
            console.log(`   ⏳ Nenhum PR aberto.`);
            continue;
        }

        for (const pr of openPrs) {
            const headBranch = pr.head.ref;
            const prNumber = pr.number;
            
            const goldenComments = goldenMap[repo][headBranch];
            if (!goldenComments) continue;

            console.log(`\n✅ PR #${prNumber} (${headBranch})`);

            let reviewComments = [];
            let issueComments = [];
            try {
                reviewComments = JSON.parse(execSync(`gh api repos/${repo}/pulls/${prNumber}/comments`, { encoding: 'utf-8' }));
                issueComments = JSON.parse(execSync(`gh api repos/${repo}/issues/${prNumber}/comments`, { encoding: 'utf-8' }));
            } catch (err) {}

            const actualComments = [
                ...reviewComments.map(c => `[LINHA ${c.line || 'GERAL'}] ${c.body}`),
                ...issueComments.map(c => `[GERAL] ${c.body}`)
            ];

            if (actualComments.length === 0) {
                console.log(`   -> ⏳ Nenhum comentário encontrado ainda. (Aguardando Worker)`);
                continue;
            }

            const allCommentsText = actualComments.join('\n\n--- PRÓXIMO COMENTÁRIO ---\n\n');
            let prGolden = goldenComments.length;
            let prCovered = 0;
            
            totalGolden += prGolden;
            statsByRepo[repo].golden += prGolden;

            for (const golden of goldenComments) {
                console.log(`   🔸 Esperado (${golden.severity}): ${golden.comment}`);
                
                const prompt = `You are an expert software engineering judge evaluating an AI Code Review tool.
Target Bug (Golden Comment): "${golden.comment}"
Actual AI Review Comments: """${allCommentsText}"""

Did the AI reviewer find this bug? 
Consider it "found" (true) IF:
1. The AI points out the same conceptual flaw or bug.
2. The AI highlights the correct problematic code and suggests a fix that would resolve the core issue mentioned in the Golden Comment, even if explained differently.
3. The AI is warning about the same failure mode/crash/vulnerability.
Respond ONLY with a valid JSON object in the following format:
{"found": boolean, "reason": "Explain your thought process. Quote the actual AI comment if it was found."}`;

                try {
                    const evaluation = await callGemini(prompt);
                    if (evaluation.found) {
                        console.log(`      🟢 ENCONTRADO!`);
                        console.log(`      📝 Motivo: ${evaluation.reason.substring(0, 100)}...`);
                        prCovered++;
                        totalCovered++;
                        statsByRepo[repo].covered++;
                    } else {
                        console.log(`      🔴 FALSO NEGATIVO.`);
                    }
                } catch (e) {
                    console.log(`      ⚠️ Erro LLM Judge: ${e.message}`);
                }
            }
            console.log(`   📊 ${prCovered}/${prGolden} (${Math.round((prCovered/prGolden)*100)}%) no PR #${prNumber}`);
        }
    }

    if (totalGolden > 0) {
        console.log("\n==================================================");
        console.log("🏆 RESULTADO FINAL DA BATERIA DE TESTES");
        console.log("==================================================");
        console.log(`📈 TAXA GLOBAL DE ACERTOS: ${totalCovered}/${totalGolden} (${Math.round((totalCovered/totalGolden)*100)}%)`);
        
        for (const repo of repos) {
            if (statsByRepo[repo].golden > 0) {
                console.log(`   - ${repo}: ${statsByRepo[repo].covered}/${statsByRepo[repo].golden} (${Math.round((statsByRepo[repo].covered/statsByRepo[repo].golden)*100)}%)`);
            }
        }
    }
}
main();

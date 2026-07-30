/**
 * Este script faz um trigger real de um Code Review na API da Kodus
 * usando um PR recém criado e acompanha os logs do RabbitMQ/Worker
 * para vermos exatamente as chamadas de tools do Agente.
 */
import fs from 'fs/promises';
import { execSync, spawn } from 'child_process';

const KODUS_API = 'http://localhost:3000';
const KODUS_TEAM_KEY = process.env.KODUS_TEAM_KEY || 'kodus_live_83b1dc321528b12232bfb5f45811776'; 
// Substitua pela sua CLI key local ou de dev se a de cima falhar

async function main() {
    console.log("🔍 Lendo prs.json para pegar um PR de teste...");
    const prsData = JSON.parse(await fs.readFile('prs.json', 'utf-8'));
    
    // Pegar o primeiro PR do Sentry como cobaia
    const targetPr = prsData.prs.find(p => p.repo.includes('sentry'));
    if (!targetPr) {
        console.error("Nenhum PR do Sentry encontrado no prs.json");
        process.exit(1);
    }

    const repoFullName = targetPr.repo; // ex: Wellington01/sentry-greptile
    console.log(`🎯 Repositório Alvo: ${repoFullName}`);
    console.log(`🌿 Branch: ${targetPr.head}`);

    // Achar o PR aberto no GitHub para essa branch
    console.log("🐙 Buscando o número do PR no GitHub...");
    let openPrs = [];
    try {
        openPrs = JSON.parse(execSync(`gh api repos/${repoFullName}/pulls?state=open&head=Wellington01:${targetPr.head}`, { encoding: 'utf-8' }));
    } catch (e) {
        console.error("Erro ao buscar PR no GitHub. Você tem o gh auth setup?");
        process.exit(1);
    }

    if (openPrs.length === 0) {
        console.error(`Nenhum PR aberto encontrado para a branch ${targetPr.head}`);
        process.exit(1);
    }

    const prNumber = openPrs[0].number;
    console.log(`✅ PR Encontrado: #${prNumber}`);

    console.log("\n🚀 Disparando Code Review manual via Kodus API...");
    
    // Disparar o webhook manual ou endpoint de CLI Review
    try {
        const response = await fetch(`${KODUS_API}/v1/reviews/trigger`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-team-key': KODUS_TEAM_KEY
            },
            body: JSON.stringify({
                repository: repoFullName,
                prNumber: prNumber,
                force: true // forçar re-review ignorando cache
            })
        });

        if (!response.ok) {
            const err = await response.text();
            console.error(`❌ Falha ao disparar review: HTTP ${response.status} - ${err}`);
            console.log("\n💡 Dica: Se a API local não estiver rodando na porta 3000, inicie o ambiente com 'pnpm run docker:start:all'");
            process.exit(1);
        }

        const data = await response.json();
        console.log(`✅ Review enfileirado com sucesso! Job ID: ${data.jobId || 'N/A'}`);
    } catch (e) {
        console.error("❌ Erro de conexão com a API da Kodus:", e.message);
        console.log("⚠️  A API local (http://localhost:3000) parece estar offline. Certifique-se de que o NestJS está rodando.");
        process.exit(1);
    }

    console.log("\n📡 Anexando aos logs do Worker para espionar os Agentes e suas Tools em tempo real...");
    console.log("==========================================================================");
    
    // Usar docker logs para seguir o worker (assumindo que roda via pnpm run docker:start ou similar)
    // Filtramos apenas logs relevantes de AgentLoop, Tool Calls e Sandbox
    const logProcess = spawn('docker', ['logs', '-f', 'kodus-worker-1'], { shell: true });
    
    // Alternativa: se você roda localmente fora do docker, podemos fazer um tail no arquivo de log
    // const logProcess = spawn('tail', ['-f', 'logs/worker.log']);

    logProcess.stdout.on('data', (data) => {
        const text = data.toString();
        // Filtrar o "barulho" e focar no que importa para nós: Agentes e Ferramentas
        if (text.includes('[AGENT]') || 
            text.includes('[TOOL CALL]') || 
            text.includes('AgentLoop') ||
            text.includes('sandbox') ||
            text.includes('generateText') ||
            text.includes('step=')) {
            process.stdout.write(text);
        }
    });

    logProcess.stderr.on('data', (data) => {
        const text = data.toString();
        if (text.includes('[AGENT]') || text.includes('AgentLoop')) {
            process.stderr.write(text);
        }
    });

    console.log("(Pressione Ctrl+C para sair do log tail quando o review terminar)");
}

main();

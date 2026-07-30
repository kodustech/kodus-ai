#!/usr/bin/env node

const localtunnel = require('localtunnel');
const fs = require('fs');
const path = require('path');

const colors = {
    blue: '\x1b[34m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    reset: '\x1b[0m'
};

const log = (color, message) => {
    console.log(`${color}${message}${colors.reset}`);
};

const updateEnvFile = (tunnelUrl) => {
    const envPath = path.join(process.cwd(), '.env');
    
    if (!fs.existsSync(envPath)) {
        log(colors.red, '❌ .env file not found. Run "pnpm run setup" first.');
        process.exit(1);
    }

    let envContent = fs.readFileSync(envPath, 'utf8');
    
    // URLs para atualizar
    const urlMappings = [
        {
            key: 'API_GITHUB_CODE_MANAGEMENT_WEBHOOK',
            value: `${tunnelUrl}/github/webhook`
        },
        {
            key: 'API_GITLAB_CODE_MANAGEMENT_WEBHOOK',
            value: `${tunnelUrl}/gitlab/webhook`
        },
        {
            key: 'GLOBAL_BITBUCKET_CODE_MANAGEMENT_WEBHOOK',
            value: `${tunnelUrl}/bitbucket/webhook`
        },
        {
            key: 'GLOBAL_AZURE_REPOS_CODE_MANAGEMENT_WEBHOOK',
            value: `${tunnelUrl}/azure-repos/webhook`
        },
        {
            key: 'API_FORGEJO_CODE_MANAGEMENT_WEBHOOK',
            value: `${tunnelUrl}/forgejo/webhook`
        },
        {
            key: 'API_SIGNUP_NOTIFICATION_WEBHOOK',
            value: `${tunnelUrl}/signup/webhook`
        }
    ];

    // Atualizar cada URL
    urlMappings.forEach(({ key, value }) => {
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
            log(colors.green, `✅ Updated ${key}`);
        }
    });

    // Salvar arquivo atualizado
    fs.writeFileSync(envPath, envContent);
    log(colors.green, '✅ .env file updated successfully!');
};

const startTunnel = async () => {
    try {
        log(colors.blue, '🌐 Kodus AI - Tunnel Setup');
        log(colors.blue, '==========================');
        
        log(colors.yellow, '🚀 Starting localtunnel...');
        
        const tunnel = await localtunnel({ 
            port: 3332,
            subdomain: 'kodus-dev' // URL fixa: kodus-dev.loca.lt
        });

        log(colors.green, `✅ Tunnel created successfully!`);
        log(colors.green, `🌐 Public URL: ${tunnel.url}`);
        
        // Atualizar .env
        updateEnvFile(tunnel.url);
        
        // Mostrar informações
        console.log('');
        log(colors.blue, '🌐 Your webhooks are now accessible at:');
        log(colors.yellow, `   GitHub: ${tunnel.url}/github/webhook`);
        log(colors.yellow, `   GitLab: ${tunnel.url}/gitlab/webhook`);
        log(colors.yellow, `   Bitbucket: ${tunnel.url}/bitbucket/webhook`);
        log(colors.yellow, `   Azure: ${tunnel.url}/azure-repos/webhook`);
        log(colors.yellow, `   Forgejo: ${tunnel.url}/forgejo/webhook`);
        console.log('');
        log(colors.blue, '💡 Press Ctrl+C to stop the tunnel');
        console.log('');
        
        // Eventos do túnel
        tunnel.on('close', () => {
            log(colors.yellow, '🔌 Tunnel closed');
            process.exit(0);
        });

        tunnel.on('error', (err) => {
            log(colors.red, `❌ Tunnel error: ${err.message}`);
            process.exit(1);
        });

        // Manter o processo rodando
        process.on('SIGINT', () => {
            log(colors.yellow, '🛑 Shutting down tunnel...');
            tunnel.close();
        });

    } catch (error) {
        log(colors.red, `❌ Failed to create tunnel: ${error.message}`);
        process.exit(1);
    }
};

// Iniciar o túnel
startTunnel();

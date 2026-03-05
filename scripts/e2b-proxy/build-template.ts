import { Template, waitForPort, defaultBuildLogger } from 'e2b';
import * as fs from 'fs';
import * as path from 'path';

async function build() {
    const serverHost = process.env.PROXY_SERVER_HOST;
    const serverPassword = process.env.PROXY_SERVER_PASSWORD;
    const e2bApiKey = process.env.API_E2B_KEY;
    const templateAlias = process.env.API_E2B_TEMPLATE_ID || 'kodus-proxy-template';

    if (!serverHost || !serverPassword || !e2bApiKey) {
        console.error('❌ Missing required env vars: PROXY_SERVER_HOST, PROXY_SERVER_PASSWORD, API_E2B_KEY');
        process.exit(1);
    }

    const workDir = __dirname;
    const configPath = path.join(workDir, 'config.json');
    const rulesPath = path.join(workDir, 'iptables-rules.sh');

    const configJson = {
        server: serverHost,
        server_port: 8388,
        password: serverPassword,
        method: 'aes-256-gcm',
        local_address: '0.0.0.0',
        local_port: 1080,
        mode: 'tcp'
    };

    const iptablesRules = `#!/bin/bash
iptables -t nat -N SHADOWSOCKS
iptables -t nat -A SHADOWSOCKS -d ${serverHost} -j RETURN
iptables -t nat -A SHADOWSOCKS -d 0.0.0.0/8 -j RETURN
iptables -t nat -A SHADOWSOCKS -d 127.0.0.0/8 -j RETURN
iptables -t nat -A SHADOWSOCKS -d 169.254.0.0/16 -j RETURN
iptables -t nat -A SHADOWSOCKS -p tcp -j REDIRECT --to-ports 1080
iptables -t nat -A OUTPUT -p tcp -j SHADOWSOCKS
`;

    // Create temporary files for E2B Template Builder
    fs.writeFileSync(configPath, JSON.stringify(configJson, null, 2));
    fs.writeFileSync(rulesPath, iptablesRules);

    const shadowsocksVersion = '1.24.0';
    const downloadUrl = `https://github.com/shadowsocks/shadowsocks-rust/releases/latest/download/shadowsocks-v${shadowsocksVersion}.x86_64-unknown-linux-gnu.tar.xz`;

    const template = Template()
        .fromBaseImage()
        .aptInstall('iptables')
        .runCmd([
            `wget ${downloadUrl}`,
            'tar -xf shadowsocks-*.tar.xz',
            'sudo mv sslocal /usr/local/bin/'
        ])
        .copy(configPath, 'config.json')
        .copy(rulesPath, 'iptables-rules.sh', { mode: 0o755 })
        .setStartCmd(
            'sudo sslocal -c config.json --protocol redir -b 0.0.0.0:1080 --daemonize && sudo ./iptables-rules.sh',
            waitForPort(1080)
        );

    console.log(`🚀 Building E2B Template with Transparent Proxy...`);
    console.log(`📌 Alias: ${templateAlias}`);
    console.log(`📌 Proxy Server: ${serverHost}`);

    try {
        await Template.build(template, {
            alias: templateAlias,
            memoryMB: 1024,
            cpuCount: 1,
            apiKey: e2bApiKey,
            onBuildLogs: defaultBuildLogger()
        });

        console.log('✅ Done! Template built successfully.');
    } catch (error) {
        console.error('❌ Failed to build template:', error);
    } finally {
        // Cleanup temp files
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
        if (fs.existsSync(rulesPath)) fs.unlinkSync(rulesPath);
    }
}

build().catch(console.error);

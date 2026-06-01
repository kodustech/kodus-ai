export interface RemoteInstallInstructionSet {
    primary: string;
    fallback?: string;
}

const UNIX_INSTALLER_URL =
    'https://raw.githubusercontent.com/kodustech/cli/main/install.sh';
const WINDOWS_INSTALLER_URL =
    'https://raw.githubusercontent.com/kodustech/cli/main/install.ps1';

export function resolveRemoteInstallInstructions(
    platform = process.platform,
): RemoteInstallInstructionSet {
    if (platform === 'win32') {
        return {
            primary: `powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp = Join-Path $env:TEMP 'kodus-install.ps1'; Invoke-WebRequest ${WINDOWS_INSTALLER_URL} -OutFile $tmp; & $tmp"`,
            fallback: `powershell -NoProfile -ExecutionPolicy Bypass -Command "$scriptPath = Join-Path (Get-Location) 'install.ps1'; Invoke-WebRequest ${WINDOWS_INSTALLER_URL} -OutFile $scriptPath; & $scriptPath"`,
        };
    }

    return {
        primary: `curl -fsSL ${UNIX_INSTALLER_URL} | bash`,
        fallback: [
            `curl -fsSL ${UNIX_INSTALLER_URL} -o /tmp/kodus-install.sh`,
            'bash /tmp/kodus-install.sh',
        ].join(' && '),
    };
}

import { input, password, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { authService } from '../../services/auth.service.js';
import { closeApiClient } from '../../services/api/api-core.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

/**
 * Free the resources that would otherwise keep the CLI process alive
 * after the login finishes:
 *   - the long-lived undici dispatcher (60 min keep-alive on idle sockets)
 *   - any raw-mode the previous inquirer prompt may have left on stdin
 * Without this the user is dropped back to the shell with raw stdin,
 * which renders keypresses as escape sequences (`^M^A^[A...`) and the
 * process never exits on its own.
 */
async function releaseTerminal(): Promise<void> {
    await closeApiClient();
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        try {
            process.stdin.setRawMode(false);
        } catch {
            // ignore
        }
    }
    // Stop holding the event loop via stdin even if some library left
    // it `resume()`d. pause() is safe whether or not it was active.
    process.stdin.pause();
}

interface LoginOptions {
    email?: string;
    password?: string;
    /** Force the device-code (RFC 8628) flow. Useful for headless / SSH. */
    deviceCode?: boolean;
    /** Use the legacy email+password flow (kept for CI/scripts). */
    legacy?: boolean;
}

export async function loginAction(options: LoginOptions): Promise<void> {
    const spinner = ora();

    try {
        const isAuthenticated = await authService.isAuthenticated();

        if (
            isAuthenticated &&
            !options.email &&
            !options.deviceCode &&
            !options.legacy
        ) {
            const credentials = await authService.getCredentials();
            const email = credentials?.user?.email;
            cliInfo(
                chalk.yellow(
                    email
                        ? `\nAlready logged in as ${email}`
                        : '\nAlready authenticated with team key',
                ),
            );

            const shouldRelogin = await confirm({
                message: email
                    ? 'Do you want to login with a different account?'
                    : 'Do you want to login with an account instead?',
                default: false,
            });

            if (!shouldRelogin) {
                await releaseTerminal();
                return;
            }
        }

        const useLegacy =
            options.legacy ||
            Boolean(options.email) ||
            Boolean(options.password);

        if (useLegacy) {
            await runLegacyLogin(options, spinner);
            await releaseTerminal();
            return;
        }

        if (options.deviceCode || !canOpenBrowser()) {
            await runDeviceCodeLogin(spinner);
            await releaseTerminal();
            return;
        }

        await runBrowserLogin(spinner);
        await releaseTerminal();
    } catch (error) {
        if (error instanceof Error && error.message.includes('force closed')) {
            cliInfo(chalk.yellow('\nOperation cancelled'));
            await releaseTerminal();
            return;
        }

        spinner.fail(chalk.red('Login failed'));

        if (error instanceof Error) {
            cliError(chalk.red(error.message));
        }
        await releaseTerminal();
        exitWithCode(1);
    }
}

async function runBrowserLogin(spinner: ReturnType<typeof ora>): Promise<void> {
    spinner.start(chalk.cyan('Opening Kodus in your browser...'));

    const user = await authService.loginViaBrowser({
        onOpenUrl: (url) => {
            spinner.stop();
            cliInfo(chalk.cyan('\nIf the browser did not open, paste this URL:'));
            cliInfo(chalk.underline(url));
            cliInfo('');
            spinner.start(chalk.cyan('Waiting for authorization...'));
        },
    });

    spinner.succeed(chalk.green(`Logged in as ${user.email}`));
}

async function runDeviceCodeLogin(
    spinner: ReturnType<typeof ora>,
): Promise<void> {
    const user = await authService.loginViaDeviceCode({
        onPrompt: (prompt) => {
            cliInfo('');
            cliInfo(chalk.cyan('Open this URL to authorize the CLI:'));
            cliInfo(`  ${chalk.underline(prompt.verificationUri)}`);
            cliInfo('');
            cliInfo(chalk.cyan('Then enter this code:'));
            cliInfo(`  ${chalk.bold(prompt.userCode)}`);
            cliInfo('');
            cliInfo(
                chalk.dim(
                    `Code expires in ${Math.round(prompt.expiresIn / 60)} minutes.`,
                ),
            );
            spinner.start(chalk.cyan('Waiting for authorization...'));
        },
    });

    spinner.succeed(chalk.green(`Logged in as ${user.email}`));
}

async function runLegacyLogin(
    options: LoginOptions,
    spinner: ReturnType<typeof ora>,
): Promise<void> {
    cliInfo(
        chalk.yellow(
            '\n[deprecated] Email + password login is kept for CI scripts. ' +
                'For interactive use, run `kodus auth login` (without flags) ' +
                'to authenticate via the browser instead.',
        ),
    );

    let email = options.email;
    let pwd = options.password;

    if (!email) {
        email = await input({
            message: 'Email:',
            validate: (value) => {
                if (!value || !value.includes('@')) {
                    return 'Please enter a valid email';
                }
                return true;
            },
        });
    }

    if (!pwd) {
        pwd = await password({
            message: 'Password:',
            mask: '*',
            validate: (value) => {
                if (!value || value.length < 6) {
                    return 'Password must be at least 6 characters';
                }
                return true;
            },
        });
    }

    spinner.start(chalk.blue('Logging in...'));
    await authService.login(email!, pwd!);
    spinner.succeed(chalk.green(`Logged in as ${email}`));
}

function canOpenBrowser(): boolean {
    // Heuristics: a real interactive terminal with no SSH session typically
    // means a developer machine where opening the browser works.
    if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT) {return false;}
    if (process.env.CI) {return false;}
    if (!process.stdout.isTTY) {return false;}
    return true;
}

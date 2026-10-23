// Commands invoked from a window the way its own page script would, and the
// confirmation windows the backend opens for them: what the security and vault
// tests share.
import { expect, type Page } from '@playwright/test';
import type { RunningApp } from './app.ts';
import { confirmationsShown } from './windows.ts';

export type Answer = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * Invokes a command from a window, as its own page script would. A window the
 * command closed has no answer to give; that is said as a refusal, so the
 * test's own assertion is what fails.
 */
export function call(
  page: Page,
  command: string,
  args: Record<string, unknown> = {},
): Promise<Answer> {
  return page
    .evaluate(
      ([command, args]) => {
        const internals = (
          globalThis as unknown as {
            __TAURI_INTERNALS__: { invoke: (_c: string, _a: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__;
        return internals.invoke(command, args).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      },
      [command, args] as const,
    )
    .catch((error: unknown) => ({
      ok: false as const,
      error: `the window closed while answering: ${String(error)}`,
    }));
}

/**
 * The error code a refused command answered with, or the ACL's refusal text;
 * for one carried out, what it answered. The test asserts on it, so a failure
 * points at the test's own line.
 */
export function refusal(answer: Answer): string {
  if (answer.ok) return `carried out: ${JSON.stringify(answer.value)}`;
  const { error } = answer;
  return typeof error === 'string' ? error : (error as { code: string }).code;
}

export const notAllowed = /not allowed/i;

export async function grant(page: Page, operation: string, target: string): Promise<string> {
  const answer = await call(page, 'plugin:sensitive|authorize_sensitive', { operation, target });
  expect(answer, `grant for ${operation}`).toMatchObject({ ok: true });
  return (answer as { value: { token: string } }).value.token;
}

export const vaultStatus = async (page: Page) =>
  ((await call(page, 'vault_status')) as { value: { configured: boolean; locked: boolean } }).value;

export const MASTER = 'e2e master password 2026';

export async function setUpVault(page: Page) {
  expect(await call(page, 'vault_setup', { masterPassword: MASTER })).toMatchObject({ ok: true });
}

/**
 * Starts asking for a grant. The answer comes once the confirmation is
 * answered, and a request still waiting after half a minute fails the test.
 */
export const ask = (page: Page, operation: string, target: string) =>
  Promise.race([
    call(page, 'plugin:sensitive|authorize_sensitive', { operation, target }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${operation} still waiting after 30 s`)), 30_000),
    ),
  ]);

/** The confirmation windows open now. */
export const confirmationPages = (app: RunningApp) =>
  app.page
    .context()
    .pages()
    .filter((other) => other.url().includes('security-confirmation='));

/** The request a confirmation window answers, from the address it was opened with. */
export const requestOf = (confirmation: Page) =>
  new URL(confirmation.url()).searchParams.get('security-confirmation')!;

/** Waits for `count` confirmation windows, each showing its question. */
export async function openConfirmations(app: RunningApp, count: number, text: string) {
  await expect.poll(() => confirmationPages(app).length, { timeout: 15_000 }).toBe(count);
  const pages = confirmationPages(app);
  for (const confirmation of pages) {
    await expect(confirmation.locator('body')).toContainText(text, { timeout: 15_000 });
  }
  await confirmationsShown(app.pid(), count);
  return pages;
}

export const RESET_MESSAGE =
  'Every saved password and SSH key passphrase will be permanently deleted.';

/** Whether a request is still waiting for its answer, a moment after asking. */
export const stillWaiting = async (answer: Promise<Answer>) =>
  (await Promise.race([
    answer.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1_000)),
  ])) === true;

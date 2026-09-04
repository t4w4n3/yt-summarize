/**
 * LIVE tests — these consume real OpenRouter tokens and are therefore opt-in.
 *
 * Skipped entirely unless RUN_LIVE_TESTS=1 (set by `pnpm run test:live` or
 * `mise run test-live`). Never runs under `mise run check` / CI gates.
 *
 * Key resolution order:
 *  1. OPENROUTER_API_KEY env var (explicit override)
 *  2. resolveOpenRouterKey() — podman secret / legacy bind mounts (in containers)
 *  3. host GPG decrypt of ~/.secrets/openrouter.gpg via ~/.gnupg
 *
 * The paid call is intentionally microscopic: one chat completion capped at a
 * few tokens on the configured cheap LLM, to validate the real API contract.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { config } from '../../src/shared/config.ts';
import { resolveOpenRouterKey } from '../../src/worker/stages/openrouter.ts';

const RUN_LIVE = process.env.RUN_LIVE_TESTS === '1';

/** Decrypt the host GPG-encrypted key (same convention as scripts/sync-secrets.sh). */
function decryptHostKey(): string | null {
  const gpgFile = path.join(os.homedir(), '.secrets', 'openrouter.gpg');
  const gnupgDir = path.join(os.homedir(), '.gnupg');
  if (!fs.existsSync(gpgFile) || !fs.existsSync(gnupgDir)) return null;
  try {
    const out = execFileSync('gpg', ['--quiet', '--batch', '--no-tty', '--decrypt', gpgFile], {
      encoding: 'utf8',
      env: { ...process.env, GNUPGHOME: gnupgDir },
      timeout: 15_000,
    });
    const key = out
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    return key?.startsWith('sk-or-') ? key : null;
  } catch {
    return null;
  }
}

async function resolveLiveKey(): Promise<string> {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    return await resolveOpenRouterKey();
  } catch {
    const hostKey = decryptHostKey();
    if (!hostKey)
      throw new Error(
        'No OpenRouter credential found for live tests (env var, podman secret, or ~/.secrets/openrouter.gpg).',
      );
    return hostKey;
  }
}

describe('live OpenRouter (consumes tokens; opt-in via RUN_LIVE_TESTS=1)', { skip: !RUN_LIVE }, () => {
  it('micro chat completion on the configured cheap model succeeds', async () => {
    const apiKey = await resolveLiveKey();

    // A single tiny request — a handful of output tokens at most.
    // Use minimal reasoning so the micro budget covers real content,
    // not just the model's hidden thinking trace (cf. summarize stage).
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
        max_tokens: 50,
        reasoning: { effort: 'minimal' },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(res.status, 200, `expected HTTP 200 from OpenRouter chat completions`);

    const body = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning?: string | null;
          reasoning_details?: Array<{ type?: string; data?: string; summary?: string }>;
        };
        finish_reason?: string | null;
        native_finish_reason?: string | null;
      }>;
      usage?: { total_tokens?: number };
    };
    const choice = body.choices?.[0];
    const msg = choice?.message;
    const content = typeof msg?.content === 'string' ? msg.content.trim() : '';
    const reasoning = typeof msg?.reasoning === 'string' ? msg.reasoning.trim() : '';
    const hasReasoningDetails = Array.isArray(msg?.reasoning_details) && msg.reasoning_details.length > 0;
    // Reasoning models count reasoning tokens against max_tokens — 20 was too tight
    // (17 reasoning + 1 content hit max_output_tokens and truncated content to null).
    // 50 gives headroom so content is reliably present even with minimal effort.
    assert.ok(
      content.length > 0 || reasoning.length > 0 || hasReasoningDetails,
      `expected non-empty completion (content or reasoning), got finish_reason=${choice?.finish_reason} native=${choice?.native_finish_reason} body=${JSON.stringify(body).slice(0, 1000)}`,
    );
    assert.ok((body.usage?.total_tokens ?? 0) > 0, 'expected token accounting in usage');
  });
});

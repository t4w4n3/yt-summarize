import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../shared/constants.ts';
import { resolveOpenRouterKey } from './openrouter.ts';
import type { StageContext } from './process.ts';
import { StageError } from './process.ts';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

function appendLog(logPath: string | undefined, line: string): void {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch {}
}

/** Pull choices[0].message.content out of an untyped JSON body, defensively. */
function extractContent(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } } | null;
  const content = first?.message?.content;
  return typeof content === 'string' ? content : null;
}

// The summarizer is a single text-in/text-out HTTPS call, exactly like the
// transcription stage. No agent runtime is needed: system prompt + transcript
// in, Markdown out.
export async function summarize(transcriptPath: string, context: StageContext): Promise<string> {
  const apiKey = await resolveOpenRouterKey();
  // The prompt ships with an {{OUTPUT_LANGUAGE}} slot filled per job; anything
  // that isn't a clean two-letter code falls back to English.
  const rawLang = typeof context.lang === 'string' ? context.lang.trim().toLowerCase() : '';
  const lang = /^[a-z]{2}$/.test(rawLang) ? rawLang : 'en';
  const systemPrompt = fs
    .readFileSync(path.join(import.meta.dirname, '..', 'prompts', 'summarize.md'), 'utf8')
    .replaceAll('{{OUTPUT_LANGUAGE}}', lang);
  const transcript = fs.readFileSync(transcriptPath, 'utf8');

  const controller = new AbortController();
  const timeoutMs = context.timeoutMs || 10 * 60 * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // The stage timeout and the job-level cancellation both abort the fetch.
  const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
  let response: Response;
  try {
    appendLog(
      context.logPath,
      `$ POST ${API_URL} (model=${config.llmModel}, reasoning=${config.llmThinking}, lang=${lang})`,
    );
    response = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.llmModel,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Summarize this video transcript into the requested Markdown structure.\n\n${transcript}`,
          },
        ],
        reasoning: { effort: config.llmThinking },
      }),
      signal,
    });
  } catch (error) {
    if (context.signal?.aborted) {
      throw new StageError('The job was cancelled.', 'summarizing');
    }
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : '';
    throw new StageError(
      name === 'AbortError' ? 'Summarization timed out.' : 'The summarization API could not be reached.',
      'summarizing',
      message,
    );
  } finally {
    clearTimeout(timeout);
  }

  let body: unknown = {};
  try {
    body = await response.json();
  } catch {}
  let markdown = extractContent(body);
  markdown = markdown ? markdown.trim() : '';
  if (!response.ok || !markdown) {
    throw new StageError(
      `Summarization failed (HTTP ${response.status}).`,
      'summarizing',
      JSON.stringify(body).slice(0, 1000),
    );
  }
  if (markdown.startsWith('```markdown') && markdown.endsWith('```')) markdown = markdown.slice(11, -3).trim();
  return markdown;
}

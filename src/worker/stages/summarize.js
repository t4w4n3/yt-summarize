const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../../shared/constants');
const { StageError } = require('./process');
const { resolveOpenRouterKey } = require('./openrouter');

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

function appendLog(logPath, line) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch {}
}

// The summarizer is a single text-in/text-out HTTPS call, exactly like the
// transcription stage. No agent runtime is needed: system prompt + transcript
// in, Markdown out.
async function summarize(transcriptPath, context) {
  const apiKey = await resolveOpenRouterKey();
  const systemPrompt = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'summarize.md'), 'utf8');
  const transcript = fs.readFileSync(transcriptPath, 'utf8');

  const controller = new AbortController();
  const timeoutMs = context.timeoutMs || 10 * 60 * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // The stage timeout and the job-level cancellation both abort the fetch.
  const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
  let response;
  try {
    appendLog(context.logPath, `$ POST ${API_URL} (model=${config.llmModel}, reasoning=${config.llmThinking})`);
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
    throw new StageError(
      error.name === 'AbortError' ? 'Summarization timed out.' : 'The summarization API could not be reached.',
      'summarizing',
      error.message,
    );
  } finally {
    clearTimeout(timeout);
  }

  const body = await response.json().catch(() => ({}));
  const content = body?.choices?.[0]?.message?.content;
  let markdown = typeof content === 'string' ? content.trim() : '';
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

module.exports = { summarize };

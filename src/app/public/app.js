(() => {
  const form = document.querySelector('#summarize-form');
  const input = document.querySelector('#video-url');
  const submitButton = document.querySelector('#submit-button');
  const urlError = document.querySelector('#url-error');
  const statusMessage = document.querySelector('#status-message');
  const queueState = document.querySelector('#queue-state');
  const footerState = document.querySelector('#footer-state');
  const wordCount = document.querySelector('#word-count');
  const emptyNote = document.querySelector('#note-empty');
  const noteContent = document.querySelector('#note-content');
  const loading = document.querySelector('#output-loading');
  const errorPanel = document.querySelector('#output-error');
  const errorCopy = document.querySelector('#output-error-copy');
  const loadingCopy = document.querySelector('#loading-copy');
  const markdownOutput = document.querySelector('#markdown-output');
  const noteTitle = document.querySelector('#note-title');
  const outputSubtitle = document.querySelector('#output-subtitle');
  const downloadButton = document.querySelector('#download-button');
  const sampleButton = document.querySelector('#sample-button');
  const toast = document.querySelector('#toast');
  const steps = [...document.querySelectorAll('.pipeline-step')];
  const clock = document.querySelector('#clock');
  let currentJobId = null;
  let pollTimer = null;
  let currentMarkdown = '';

  const demoMarkdown = `## Overview

A good study note keeps the shape of an idea visible after the video is gone. This sample shows the kind of durable, structured document the workstation produces from a transcript.

## Key Takeaways

- Capture the central claim before collecting supporting details.
- Define unfamiliar terms at the moment they become useful.
- Preserve examples, numbers, and the speaker's own vocabulary.
- End with actions that turn understanding into a next step.

## Core Concepts

**Retrieval practice** is the act of recalling an idea without looking at the source. It exposes gaps more reliably than rereading.

**Progressive compression** means reducing a long explanation into layers: full note, short outline, and one-sentence recall cue.

## Steps & Techniques

1. Listen once for the argument and its turning points.
2. Rebuild the explanation as concepts, evidence, and decisions.
3. Mark the smallest useful action for later review.

## Action Items

- Revisit this note tomorrow without replaying the video.
- Add a concrete example if a concept still feels abstract.`;

  function tickClock() {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  tickClock();
  setInterval(tickClock, 30_000);

  function isYouTubeUrl(value) {
    try {
      const url = new URL(value);
      const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'];
      return ['http:', 'https:'].includes(url.protocol) && hosts.includes(url.hostname.toLowerCase()) && (url.hostname.includes('youtu.be') ? url.pathname.length > 1 : url.pathname === '/watch' && url.searchParams.has('v'));
    } catch { return false; }
  }

  function setBusy(busy) {
    document.body.classList.toggle('is-busy', busy);
    input.disabled = busy;
    submitButton.disabled = busy;
    submitButton.innerHTML = busy ? 'WORKING<span class="button-corner" aria-hidden="true">…</span>' : 'SUMMARIZE<span class="button-corner" aria-hidden="true">↵</span>';
  }

  function resetPanels() {
    emptyNote.hidden = false;
    noteContent.hidden = true;
    loading.hidden = true;
    errorPanel.hidden = true;
    urlError.hidden = true;
    input.removeAttribute('aria-invalid');
    steps.forEach(step => step.classList.remove('is-active', 'is-done'));
    queueState.textContent = 'EMPTY';
    footerState.textContent = 'IDLE';
    wordCount.textContent = 'NO WORDS';
    outputSubtitle.textContent = 'Your rendered Markdown will open here.';
    statusMessage.textContent = 'READY — waiting for a source';
    currentJobId = null;
    currentMarkdown = '';
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 3200);
  }

  function setStage(stage) {
    const stageIndex = ['downloading', 'converting', 'transcribing', 'summarizing'].indexOf(stage);
    steps.forEach((step, index) => {
      step.classList.toggle('is-active', index === stageIndex);
      step.classList.toggle('is-done', index >= 0 && index < stageIndex);
    });
    const label = stage ? stage.toUpperCase() : 'WORKING';
    statusMessage.textContent = `${label} — the worker is on it`;
    footerState.textContent = label;
    queueState.textContent = '1 ACTIVE';
    loadingCopy.textContent = `${label} — building your study note…`;
  }

  function showSample() {
    currentMarkdown = demoMarkdown;
    emptyNote.hidden = true;
    loading.hidden = true;
    errorPanel.hidden = true;
    noteContent.hidden = false;
    noteTitle.textContent = 'How to make a note worth keeping';
    outputSubtitle.textContent = 'SAMPLE NOTE · rendered from Markdown';
    markdownOutput.innerHTML = markdownToHtml(demoMarkdown);
    wordCount.textContent = `${demoMarkdown.split(/\s+/).length} WORDS`;
    footerState.textContent = 'SAMPLE';
    queueState.textContent = 'DEMO';
    statusMessage.textContent = 'SAMPLE — this is the shape of a finished note';
    showToast('Sample note opened. Paste a URL to run the real pipeline.');
  }

  function markdownToHtml(markdown) {
    // Small safe renderer for the static v1 surface. API output is escaped before formatting.
    const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
    const lines = markdown.split(/\r?\n/);
    let html = '';
    let listTag = null;
    const closeList = () => { if (listTag) { html += `</${listTag}>`; listTag = null; } };
    for (const line of lines) {
      if (line.startsWith('## ')) { closeList(); html += `<h2>${escape(line.slice(3))}</h2>`; }
      else if (line.startsWith('- ')) { if (listTag !== 'ul') { closeList(); html += '<ul>'; listTag = 'ul'; } html += `<li>${inline(escape(line.slice(2)))}</li>`; }
      else if (/^\d+\. /.test(line)) { if (listTag !== 'ol') { closeList(); html += '<ol>'; listTag = 'ol'; } html += `<li>${inline(escape(line.replace(/^\d+\. /, '')))}</li>`; }
      else if (!line.trim()) { closeList(); }
      else { closeList(); html += `<p>${inline(escape(line))}</p>`; }
    }
    closeList();
    return html;
  }

  function inline(text) {
    return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
  }

  async function submit(event) {
    event.preventDefault();
    const url = input.value.trim();
    if (!isYouTubeUrl(url)) {
      input.setAttribute('aria-invalid', 'true');
      urlError.hidden = false;
      input.focus();
      return;
    }
    urlError.hidden = true;
    input.removeAttribute('aria-invalid');
    emptyNote.hidden = true;
    noteContent.hidden = true;
    errorPanel.hidden = true;
    loading.hidden = false;
    setBusy(true);
    statusMessage.textContent = 'QUEUED — waiting for the worker';
    queueState.textContent = '1 QUEUED';
    footerState.textContent = 'QUEUED';
    try {
      const response = await fetch('/api/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not create this job.');
      currentJobId = data.jobId;
      pollTimer = window.setInterval(pollStatus, 2000);
      await pollStatus();
    } catch (error) {
      showError(error.message);
    }
  }

  async function pollStatus() {
    if (!currentJobId) return;
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(currentJobId)}`);
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || 'Could not read job status.');
      if (job.status === 'queued') { queueState.textContent = '1 QUEUED'; footerState.textContent = 'QUEUED'; statusMessage.textContent = 'QUEUED — waiting for the worker'; return; }
      if (job.status === 'running') { setStage(job.stage); return; }
      window.clearInterval(pollTimer);
      if (job.status === 'done') return finish(job);
      showError(job.error || 'The worker stopped before the note was ready.');
    } catch (error) {
      window.clearInterval(pollTimer);
      showError(error.message);
    }
  }

  async function finish(job) {
    const response = await fetch(`/api/jobs/${encodeURIComponent(currentJobId)}/result`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The note was marked done but could not be opened.');
    currentMarkdown = result.markdown;
    noteTitle.textContent = result.title || 'Untitled study note';
    outputSubtitle.textContent = 'READY · rendered Markdown';
    markdownOutput.innerHTML = markdownToHtml(result.markdown);
    emptyNote.hidden = true;
    loading.hidden = true;
    errorPanel.hidden = true;
    noteContent.hidden = false;
    setBusy(false);
    steps.forEach(step => { step.classList.remove('is-active'); step.classList.add('is-done'); });
    queueState.textContent = 'COMPLETE';
    footerState.textContent = 'DONE';
    wordCount.textContent = `${result.wordCount || result.markdown.split(/\s+/).length} WORDS`;
    statusMessage.textContent = 'DONE — note is ready to study';
    showToast('Study note ready.');
  }

  function showError(message) {
    setBusy(false);
    loading.hidden = true;
    emptyNote.hidden = true;
    noteContent.hidden = true;
    errorPanel.hidden = false;
    errorCopy.textContent = message;
    queueState.textContent = 'FAILED';
    footerState.textContent = 'ERROR';
    statusMessage.textContent = 'ERROR — try another source';
    showToast('The note could not be completed.');
  }

  function download() {
    if (!currentMarkdown) return showToast('There is no note to download yet.');
    const blob = new Blob([currentMarkdown], { type: 'text/markdown;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${(noteTitle.textContent || 'study-note').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function reset() {
    if (pollTimer) window.clearInterval(pollTimer);
    setBusy(false);
    input.value = '';
    resetPanels();
    input.focus();
  }

  form.addEventListener('submit', submit);
  downloadButton.addEventListener('click', download);
  sampleButton.addEventListener('click', showSample);
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'reset') reset();
    if (action === 'about') showToast('Summarize YT turns one video into one durable Markdown study note.');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') reset();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); download(); }
  });
})();

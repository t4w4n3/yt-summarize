(() => {
  const form = document.querySelector('#summarize-form');
  const input = document.querySelector('#video-url');
  const submitButton = document.querySelector('#submit-button');
  const urlError = document.querySelector('#url-error');
  const statusMessage = document.querySelector('#status-message');
  const queueState = document.querySelector('#queue-state');
  const footerState = document.querySelector('#footer-state');
  const wordCount = document.querySelector('#word-count');
  const jobRef = document.querySelector('#job-ref');
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
  const resumeBar = document.querySelector('#resume-bar');
  const resumeCopy = document.querySelector('#resume-copy');
  const resumeId = document.querySelector('#resume-id');
  const resumeForget = document.querySelector('#resume-forget');
  const langRow = document.querySelector('#output-lang-row');
  const langSelect = document.querySelector('#output-lang');
  let currentJobId = null;
  let pollTimer = null;
  let currentMarkdown = '';
  let lastDeduped = false;
  let consecutivePollFailures = 0;

  const STORAGE_KEY = 'summarize-yt:lastJobId';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLL_FAILURES = 3;

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

  // Note language: default to the browser locale; English browsers get no
  // picker at all since both options would be English.
  function detectBrowserLang() {
    const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const candidate of candidates) {
      const code = (candidate || '').slice(0, 2).toLowerCase();
      if (/^[a-z]{2}$/.test(code)) return code;
    }
    return 'en';
  }

  function initLanguagePicker() {
    if (!langRow || !langSelect) return;
    const browserLang = detectBrowserLang();
    if (browserLang === 'en') return;
    let label;
    try {
      label = new Intl.DisplayNames([browserLang], { type: 'language' }).of(browserLang);
    } catch {}
    langSelect.options[0].value = browserLang;
    langSelect.options[0].textContent = label || browserLang.toUpperCase();
    langRow.hidden = false;
  }
  initLanguagePicker();

  function isYouTubeUrl(value) {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      const hosts = [
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtu.be',
        'www.youtu.be',
        'youtube-nocookie.com',
        'www.youtube-nocookie.com',
      ];
      if (!['http:', 'https:'].includes(url.protocol) || !hosts.includes(hostname)) return false;
      if (url.username || url.password || url.port) return false;
      const isShort = hostname === 'youtu.be' || hostname === 'www.youtu.be' || hostname.endsWith('.youtu.be');
      let id = null;
      if (isShort) {
        const raw = url.pathname.slice(1).split('/')[0] ?? '';
        id = (raw.split('?')[0] ?? '').split('#')[0] ?? '';
        if (id === '') id = null;
      } else {
        if (url.pathname === '/watch') {
          id = url.searchParams.get('v');
        } else {
          const parts = url.pathname.split('/').filter(Boolean);
          if (parts.length >= 2 && ['shorts', 'embed', 'v', 'live'].includes(parts[0] ?? '')) {
            id = parts[1] ?? null;
          } else return false;
        }
      }
      return !!id && /^[A-Za-z0-9_-]{11}$/.test(id);
    } catch {
      return false;
    }
  }

  function setBusy(busy) {
    document.body.classList.toggle('is-busy', busy);
    input.disabled = busy;
    submitButton.disabled = busy;
    submitButton.innerHTML = busy
      ? 'WORKING<span class="button-corner" aria-hidden="true">…</span>'
      : 'SUMMARIZE<span class="button-corner" aria-hidden="true">↵</span>';
  }

  function setJobRef(id) {
    if (!jobRef) return;
    if (!id) {
      jobRef.hidden = true;
      jobRef.textContent = '';
      return;
    }
    jobRef.hidden = false;
    jobRef.textContent = `JOB ${id.slice(0, 8)}`;
    jobRef.title = id;
  }

  function saveJobId(id) {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {}
    try {
      history.replaceState(null, '', `#${id}`);
    } catch {}
    setJobRef(id);
  }

  function clearStoredJobId() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    try {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    } catch {}
    setJobRef(null);
    if (resumeBar) resumeBar.hidden = true;
  }

  function getStoredJobId() {
    try {
      const hash = location.hash.slice(1);
      if (hash && UUID_RE.test(hash)) return hash;
    } catch {}
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v && UUID_RE.test(v)) return v;
    } catch {}
    return null;
  }

  function showResumeBar(id, copy) {
    if (!resumeBar) return;
    resumeBar.hidden = false;
    if (resumeCopy && copy) resumeCopy.textContent = copy;
    if (resumeId) {
      if (id) {
        resumeId.hidden = false;
        resumeId.textContent = id.slice(0, 8);
        resumeId.title = id;
      } else resumeId.hidden = true;
    }
  }

  function hideResumeBar() {
    if (resumeBar) resumeBar.hidden = true;
  }

  function resetPanels() {
    emptyNote.hidden = false;
    noteContent.hidden = true;
    loading.hidden = true;
    errorPanel.hidden = true;
    urlError.hidden = true;
    input.removeAttribute('aria-invalid');
    steps.forEach((step) => {
      step.classList.remove('is-active', 'is-done');
    });
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
    showToast.timer = window.setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function errorStatus(error) {
    return error && typeof error === 'object' && 'status' in error ? error.status : undefined;
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
    const escapeHtml = (value) =>
      value.replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char],
      );
    const lines = markdown.split(/\r?\n/);
    let html = '';
    let listTag = null;
    const closeList = () => {
      if (listTag) {
        html += `</${listTag}>`;
        listTag = null;
      }
    };
    for (const line of lines) {
      if (line.startsWith('## ')) {
        closeList();
        html += `<h2>${escapeHtml(line.slice(3))}</h2>`;
      } else if (line.startsWith('- ')) {
        if (listTag !== 'ul') {
          closeList();
          html += '<ul>';
          listTag = 'ul';
        }
        html += `<li>${inline(escapeHtml(line.slice(2)))}</li>`;
      } else if (/^\d+\. /.test(line)) {
        if (listTag !== 'ol') {
          closeList();
          html += '<ol>';
          listTag = 'ol';
        }
        html += `<li>${inline(escapeHtml(line.replace(/^\d+\. /, '')))}</li>`;
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList();
        html += `<p>${inline(escapeHtml(line))}</p>`;
      }
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
    hideResumeBar();
    setBusy(true);
    consecutivePollFailures = 0;
    statusMessage.textContent = 'QUEUED — waiting for the worker';
    queueState.textContent = '1 QUEUED';
    footerState.textContent = 'QUEUED';
    try {
      const response = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Omitted when the picker is hidden → the server stores 'en'.
        body: JSON.stringify({ url, lang: langRow && !langRow.hidden ? langSelect.value : undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not create this job.');
      currentJobId = data.jobId;
      lastDeduped = !!data.deduped;
      consecutivePollFailures = 0;
      saveJobId(currentJobId);
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = window.setInterval(pollStatus, POLL_INTERVAL_MS);
      if (data.deduped) {
        statusMessage.textContent = 'TROUVÉ — résumé déjà disponible';
        loadingCopy.textContent = 'TROUVÉ — ouverture instantanée…';
        showToast('Déjà résumé — affichage instantané.');
      }
      await pollStatus();
    } catch (error) {
      showError(errorMessage(error));
    }
  }

  async function pollStatus() {
    if (!currentJobId) return;
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(currentJobId)}`);
      const job = await response.json();
      if (!response.ok) {
        const statusError = new Error(job.error || 'Could not read job status.');
        statusError.status = response.status;
        throw statusError;
      }
      consecutivePollFailures = 0;
      if (job.status === 'queued') {
        queueState.textContent = '1 QUEUED';
        footerState.textContent = 'QUEUED';
        statusMessage.textContent = 'QUEUED — waiting for the worker';
        return;
      }
      if (job.status === 'running') {
        setStage(job.stage);
        return;
      }
      window.clearInterval(pollTimer);
      pollTimer = null;
      if (job.status === 'done') return finish(job);
      showError(job.error || 'The worker stopped before the note was ready.');
    } catch (error) {
      if (errorStatus(error) === 404) {
        window.clearInterval(pollTimer);
        pollTimer = null;
        clearStoredJobId();
        showError(errorMessage(error));
        return;
      }
      consecutivePollFailures += 1;
      if (consecutivePollFailures < MAX_POLL_FAILURES) {
        const retryCopy = `RECONNECTING — retry ${consecutivePollFailures}/${MAX_POLL_FAILURES}…`;
        statusMessage.textContent = retryCopy;
        footerState.textContent = 'RETRYING';
        loadingCopy.textContent = retryCopy;
        return;
      }
      window.clearInterval(pollTimer);
      pollTimer = null;
      showError(errorMessage(error));
    }
  }

  async function finish(_job) {
    try {
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
      hideResumeBar();
      setBusy(false);
      steps.forEach((step) => {
        step.classList.remove('is-active');
        step.classList.add('is-done');
      });
      queueState.textContent = 'COMPLETE';
      footerState.textContent = 'DONE';
      wordCount.textContent = `${result.wordCount || result.markdown.split(/\s+/).length} WORDS`;
      statusMessage.textContent = 'DONE — note is ready to study';
      if (lastDeduped) {
        showToast('Déjà résumé — affichage instantané.');
        lastDeduped = false;
      } else {
        showToast('Study note ready.');
      }
    } catch (error) {
      showError(errorMessage(error));
    }
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
    link.download = `${(noteTitle.textContent || 'study-note')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function reset() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    consecutivePollFailures = 0;
    setBusy(false);
    input.value = '';
    clearStoredJobId();
    resetPanels();
    input.focus();
  }

  function forgetResume() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    consecutivePollFailures = 0;
    clearStoredJobId();
    setBusy(false);
    resetPanels();
    hideResumeBar();
    showToast('Run précédent oublié.');
    input.focus();
  }

  async function resumeStoredJob() {
    const stored = getStoredJobId();
    if (!stored) return;
    currentJobId = stored;
    setJobRef(stored);
    showResumeBar(stored, 'Reconnexion au run précédent…');
    emptyNote.hidden = true;
    noteContent.hidden = true;
    errorPanel.hidden = true;
    loading.hidden = false;
    setBusy(true);
    consecutivePollFailures = 0;
    queueState.textContent = 'RESTORING';
    footerState.textContent = 'RESTORING';
    statusMessage.textContent = 'REPRISE — reconnexion au worker…';
    loadingCopy.textContent = 'RESTORING — reconnexion au worker…';
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(stored)}`);
      const job = await response.json();
      if (!response.ok) {
        const statusError = new Error(job.error || 'Job not found.');
        statusError.status = response.status;
        throw statusError;
      }
      consecutivePollFailures = 0;
      if (job.status === 'queued') {
        queueState.textContent = '1 QUEUED';
        footerState.textContent = 'QUEUED';
        statusMessage.textContent = 'QUEUED — reprise du suivi';
        loadingCopy.textContent = 'QUEUED — reprise du suivi…';
        if (pollTimer) window.clearInterval(pollTimer);
        pollTimer = window.setInterval(pollStatus, POLL_INTERVAL_MS);
        hideResumeBar();
        showToast('Run retrouvé — reprise du suivi.');
        return;
      }
      if (job.status === 'running') {
        setStage(job.stage);
        if (pollTimer) window.clearInterval(pollTimer);
        pollTimer = window.setInterval(pollStatus, POLL_INTERVAL_MS);
        hideResumeBar();
        showToast('Run retrouvé — reprise du suivi.');
        return;
      }
      if (job.status === 'done') {
        await finish(job);
        showToast('Résumé retrouvé après rechargement.');
        return;
      }
      // failed
      window.clearInterval(pollTimer);
      pollTimer = null;
      showError(job.error || 'Le run précédent a échoué.');
      showResumeBar(stored, 'Run précédent en erreur —');
      setBusy(false);
    } catch (error) {
      if (errorStatus(error) === 404) {
        clearStoredJobId();
        hideResumeBar();
        resetPanels();
        setBusy(false);
        currentJobId = null;
        return;
      }
      window.clearInterval(pollTimer);
      pollTimer = null;
      showError(errorMessage(error));
      showResumeBar(stored, 'Run précédent indisponible — rechargez pour réessayer.');
      setBusy(false);
    }
  }

  form.addEventListener('submit', submit);
  downloadButton.addEventListener('click', download);
  sampleButton.addEventListener('click', showSample);
  if (resumeForget) resumeForget.addEventListener('click', forgetResume);
  if (jobRef) {
    jobRef.style.cursor = 'pointer';
    jobRef.addEventListener('click', async () => {
      if (!currentJobId) return;
      try {
        await navigator.clipboard.writeText(currentJobId);
        showToast('Job ID copié.');
      } catch {
        showToast(currentJobId);
      }
    });
  }
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'reset') reset();
    if (action === 'about') showToast('Summarize YT turns one video into one durable Markdown study note.');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') reset();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      download();
    }
  });

  resumeStoredJob();
})();

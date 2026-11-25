(() => {
  const form = document.querySelector('#summarize-form');
  const input = document.querySelector('#video-url');
  const submitButton = document.querySelector('#submit-button');
  const urlError = document.querySelector('#url-error');
  const statusMessage = document.querySelector('#status-message');
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
  const retryButton = document.querySelector('#retry-button');
  const toast = document.querySelector('#toast');
  const steps = [...document.querySelectorAll('.pipeline-step')];
  const resumeBar = document.querySelector('#resume-bar');
  const resumeCopy = document.querySelector('#resume-copy');
  const resumeId = document.querySelector('#resume-id');
  const resumeForget = document.querySelector('#resume-forget');
  const langRow = document.querySelector('#output-lang-row');
  const langSelect = document.querySelector('#output-lang');
  const historyList = document.querySelector('#history-list');
  const historyEmpty = document.querySelector('#history-empty');
  const historySearch = document.querySelector('#history-search');
  let currentJobId = null;
  let pollTimer = null;
  let currentMarkdown = '';
  let lastDeduped = false;
  let consecutivePollFailures = 0;
  let historyTimer = null;

  const STORAGE_KEY = 'summarize-yt:lastJobId';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLL_FAILURES = 3;
  const HISTORY_LIMIT = 50;

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

  function saveJobId(id) {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {}
    try {
      history.replaceState(null, '', `#${id}`);
    } catch {}
  }

  function clearStoredJobId() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    try {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    } catch {}
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
    loadingCopy.textContent = `${label} — building your study note…`;
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
      if (line.startsWith('### ')) {
        closeList();
        html += `<h3>${escapeHtml(line.slice(4))}</h3>`;
      } else if (line.startsWith('## ')) {
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

  function displayNote(result) {
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
    wordCount.textContent = `${result.wordCount || result.markdown.split(/\s+/).length} WORDS`;
    statusMessage.textContent = 'DONE — note is ready to study';
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
        statusMessage.textContent = 'FOUND — note already available';
        loadingCopy.textContent = 'FOUND — opening instantly…';
        showToast('Already summarized — shown instantly.');
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
      showError(job.error || 'The worker stopped before the note was ready.', true);
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
      displayNote(result);
      loadHistory(historySearch?.value ?? '');
      if (lastDeduped) {
        showToast('Already summarized — shown instantly.');
        lastDeduped = false;
      } else {
        showToast('Study note ready.');
      }
    } catch (error) {
      showError(errorMessage(error));
    }
  }

  function showError(message, retryable = false) {
    setBusy(false);
    loading.hidden = true;
    emptyNote.hidden = true;
    noteContent.hidden = true;
    errorPanel.hidden = false;
    if (retryButton) retryButton.hidden = !retryable || !currentJobId;
    errorCopy.textContent = message;
    statusMessage.textContent = 'ERROR — try another source';
    showToast('The note could not be completed.');
  }

  async function retryJob() {
    if (!currentJobId) return;
    errorPanel.hidden = true;
    emptyNote.hidden = true;
    noteContent.hidden = true;
    loading.hidden = false;
    hideResumeBar();
    setBusy(true);
    consecutivePollFailures = 0;
    statusMessage.textContent = 'QUEUED — retry, resuming from saved steps';
    loadingCopy.textContent = 'QUEUED — resuming from saved steps…';
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(currentJobId)}/retry`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not retry this job.');
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = window.setInterval(pollStatus, POLL_INTERVAL_MS);
      await pollStatus();
    } catch (error) {
      showError(errorMessage(error));
    }
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
    showToast('Previous run forgotten.');
    input.focus();
  }

  async function resumeStoredJob() {
    const stored = getStoredJobId();
    if (!stored) return;
    currentJobId = stored;
    showResumeBar(stored, 'Reconnecting to the previous run…');
    emptyNote.hidden = true;
    noteContent.hidden = true;
    errorPanel.hidden = true;
    loading.hidden = false;
    setBusy(true);
    consecutivePollFailures = 0;
    statusMessage.textContent = 'RESUMING — reconnecting to the worker…';
    loadingCopy.textContent = 'RESUMING — reconnecting to the worker…';
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
        statusMessage.textContent = 'QUEUED — resuming follow-up';
        loadingCopy.textContent = 'QUEUED — resuming follow-up…';
        if (pollTimer) window.clearInterval(pollTimer);
        pollTimer = window.setInterval(pollStatus, POLL_INTERVAL_MS);
        hideResumeBar();
        showToast('Previous run found — following it again.');
        return;
      }
      if (job.status === 'running') {
        setStage(job.stage);
        if (pollTimer) window.clearInterval(pollTimer);
        pollTimer = window.setInterval(pollStatus, POLL_INTERVAL_MS);
        hideResumeBar();
        showToast('Previous run found — following it again.');
        return;
      }
      if (job.status === 'done') {
        await finish(job);
        showToast('Note found after reload.');
        return;
      }
      // failed
      window.clearInterval(pollTimer);
      pollTimer = null;
      showError(job.error || 'The previous run failed.', true);
      showResumeBar(stored, 'Previous run failed —');
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
      showResumeBar(stored, 'Previous run unavailable — reload to retry.');
      setBusy(false);
    }
  }

  function formatHistoryDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value ?? '');
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function renderHistory(jobs) {
    historyList.replaceChildren();
    for (const job of jobs) {
      const item = document.createElement('li');
      item.dataset.jobId = job.jobId;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-item';
      const title = document.createElement('span');
      title.className = 'history-title';
      title.textContent = job.title || 'Untitled study note';
      const meta = document.createElement('span');
      meta.className = 'history-meta';
      const lang = job.lang && job.lang !== 'en' ? ` · ${job.lang.toUpperCase()}` : '';
      meta.textContent = `${formatHistoryDate(job.createdAt)}${lang}`;
      button.append(title, meta);
      button.addEventListener('click', () => openHistoryJob(job.jobId));
      item.append(button);
      historyList.append(item);
    }
    historyEmpty.textContent = 'NO NOTES YET';
    historyEmpty.hidden = jobs.length > 0;
  }

  async function loadHistory(query = '') {
    try {
      const params = new URLSearchParams({ limit: String(HISTORY_LIMIT) });
      const q = query.trim();
      if (q) params.set('q', q);
      const response = await fetch(`/api/jobs?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load history.');
      renderHistory(Array.isArray(data.jobs) ? data.jobs : []);
    } catch {
      renderHistory([]);
      historyEmpty.hidden = false;
      historyEmpty.textContent = 'HISTORY UNAVAILABLE';
    }
  }

  async function openHistoryJob(jobId) {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    currentJobId = jobId;
    saveJobId(jobId);
    hideResumeBar();
    setBusy(true);
    emptyNote.hidden = true;
    noteContent.hidden = true;
    errorPanel.hidden = true;
    loading.hidden = false;
    statusMessage.textContent = 'OPENING — loading the note…';
    loadingCopy.textContent = 'OPENING — loading the note…';
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/result`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'This note could not be opened.');
      displayNote(result);
      showToast('Note opened from history.');
    } catch (error) {
      showError(errorMessage(error));
    }
  }

  form.addEventListener('submit', submit);
  downloadButton.addEventListener('click', download);
  if (retryButton) retryButton.addEventListener('click', retryJob);
  if (resumeForget) resumeForget.addEventListener('click', forgetResume);
  if (historySearch) {
    historySearch.addEventListener('input', () => {
      window.clearTimeout(historyTimer);
      historyTimer = window.setTimeout(() => loadHistory(historySearch.value), 200);
    });
  }
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'reset') reset();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') reset();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      download();
    }
  });

  loadHistory();
  resumeStoredJob();
})();

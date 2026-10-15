'use strict';

/* Website Auditor — start the audit workflow, watch every stage, fetch the report.
 *
 * Everything talks to the GitHub REST API with the visitor's own fine-grained
 * token. No secrets live in this page or its repository. All text coming back
 * from the API is rendered with textContent, never as HTML. */

const API = (() => {
  // Test hook only: lets a local mock stand in for GitHub when served from localhost.
  const override = new URLSearchParams(location.search).get('api');
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (override && local && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(override)) return override;
  return 'https://api.github.com';
})();

const $ = (id) => document.getElementById(id);
const store = {
  get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
  set(area, key, value) { try { window[area].setItem(key, value); } catch { /* storage may be blocked */ } },
  del(area, key) { try { window[area].removeItem(key); } catch { /* ignore */ } },
};

const els = {
  repo: $('repo'), workflow: $('workflow'), token: $('token'), remember: $('remember'),
  connect: $('connect'), forget: $('forget'), connPill: $('conn-pill'),
  urls: $('urls'), note: $('note'), sitemapLimit: $('sitemap-limit'), problems: $('url-problems'),
  run: $('run'), runHint: $('run-hint'),
  statusCard: $('status-card'), runPill: $('run-pill'), runMeta: $('run-meta'), bar: $('progress-bar'),
  stages: $('stages'), resultRow: $('result-row'), download: $('download'), openRun: $('open-run'), resultMsg: $('result-msg'),
  recentCard: $('recent-card'), recent: $('recent'), error: $('global-error'),
};

let watchGeneration = 0;
let currentUser = null;
let currentRun = null;

/* ---------------- settings ---------------- */

function loadSettings() {
  const hashRepo = new URLSearchParams(location.hash.replace(/^#/, '')).get('repo');
  els.repo.value = hashRepo || store.get('localStorage', 'wa.repo') || '';
  els.workflow.value = store.get('localStorage', 'wa.workflow') || 'audit.yml';
  const remembered = store.get('localStorage', 'wa.token');
  const session = store.get('sessionStorage', 'wa.token');
  els.token.value = remembered || session || '';
  els.remember.checked = !!remembered;
}

function readConfig() {
  const repo = els.repo.value.trim();
  const workflow = els.workflow.value.trim() || 'audit.yml';
  const token = els.token.value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Enter the repository as owner/repository.');
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)) throw new Error('The workflow file should look like audit.yml.');
  if (!token || /\s/.test(token)) throw new Error('Paste your GitHub personal access token first.');
  return { repo, workflow, token };
}

function saveSettings(cfg) {
  store.set('localStorage', 'wa.repo', cfg.repo);
  store.set('localStorage', 'wa.workflow', cfg.workflow);
  store.del('localStorage', 'wa.token');
  store.del('sessionStorage', 'wa.token');
  store.set(els.remember.checked ? 'localStorage' : 'sessionStorage', 'wa.token', cfg.token);
}

/* ---------------- GitHub API ---------------- */

function authHeaders(cfg) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${cfg.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

class ApiError extends Error {}

async function explain(res) {
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* no body */ }
  if (res.status === 401) return 'GitHub rejected the token — it may be expired or mistyped.';
  if (res.status === 403 && /rate limit/i.test(detail)) return 'GitHub API rate limit reached. Wait a few minutes and try again.';
  if (res.status === 403) return 'This token is not allowed to do that. It needs "Actions: Read and write" on this repository.';
  if (res.status === 404) return 'Repository or workflow not found, or the token cannot see it. Check the owner/repository name and the token\'s repository access.';
  if (res.status === 422) return `GitHub could not start the workflow: ${detail || 'invalid request'}.`;
  return `GitHub returned ${res.status}${detail ? `: ${detail}` : ''}.`;
}

async function api(cfg, path, options = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      headers: { ...authHeaders(cfg), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch {
    throw new ApiError('Could not reach GitHub. Check your internet connection.');
  }
  if (!res.ok) throw new ApiError(await explain(res));
  if (res.status === 204) return null;
  return res.json();
}

const wfPath = (cfg) => `/repos/${cfg.repo}/actions/workflows/${cfg.workflow}`;

async function listRuns(cfg, perPage = 10) {
  const data = await api(cfg, `${wfPath(cfg)}/runs?event=workflow_dispatch&per_page=${perPage}`);
  return data.workflow_runs || [];
}

/* ---------------- URL validation (mirrors scripts/resolve-urls.mjs) ---------------- */

function parseTargets(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through */ }
  }
  return t.split(/[\s,]+/).filter(Boolean);
}

function rejectReason(value) {
  let u;
  try { u = new URL(value); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http and https are supported';
  if (u.username || u.password) return 'URLs with embedded credentials are not allowed';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'localhost / internal sites cannot be reached from GitHub\'s runners';
  }
  if (!host.includes('.') && !host.includes(':')) return 'hostname must be a full domain name';
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) {
      return 'private / reserved IP addresses cannot be scanned';
    }
  }
  if (host.includes(':') && (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host))) {
    return 'private / reserved IP addresses cannot be scanned';
  }
  return null;
}

function showProblems(bad) {
  els.problems.replaceChildren();
  if (!bad.length) { els.problems.hidden = true; return; }
  els.problems.append('These entries cannot be scanned:');
  const ul = document.createElement('ul');
  for (const b of bad) {
    const li = document.createElement('li');
    li.textContent = `${b.value.length > 70 ? `${b.value.slice(0, 70)}…` : b.value} — ${b.reason}`;
    ul.append(li);
  }
  els.problems.append(ul);
  els.problems.hidden = false;
}

/* ---------------- rendering ---------------- */

function showError(message) {
  els.error.textContent = message || '';
  els.error.hidden = !message;
}

function setPill(el, text, kind) {
  el.textContent = text;
  el.className = `status-pill${kind ? ` ${kind}` : ''}`;
  el.hidden = !text;
}

function runState(run) {
  if (run.status === 'completed') {
    const c = run.conclusion;
    if (c === 'success') return ['Finished', 'pass'];
    if (c === 'cancelled') return ['Cancelled', 'warn'];
    return [`Finished with problems (${c || 'unknown'})`, 'fail'];
  }
  if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending' || run.status === 'requested') return ['Queued', 'warn'];
  return ['Running', ''];
}

function groupJobs(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const base = job.name.replace(/\s\(\d+\)$/, '');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(job);
  }
  return [...groups.entries()].map(([name, list]) => {
    const done = list.filter((j) => j.status === 'completed');
    const failed = done.filter((j) => !['success', 'skipped', 'neutral'].includes(j.conclusion));
    const running = list.filter((j) => j.status === 'in_progress');
    let kind = '';
    if (running.length) kind = 'run';
    else if (done.length === list.length) kind = failed.length ? 'fail' : 'pass';
    return { name, total: list.length, done: done.length, failed: failed.length, kind };
  });
}

function renderStages(jobs) {
  const groups = groupJobs(jobs);
  els.stages.replaceChildren();
  for (const g of groups) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${g.kind}`;
    const name = document.createElement('span');
    name.className = 'stage-name';
    name.textContent = g.name;
    const count = document.createElement('span');
    count.className = 'stage-count';
    count.textContent = g.total > 1 ? `${g.done}/${g.total} pages` : g.kind === 'pass' ? 'done' : g.kind === 'fail' ? 'failed' : g.kind === 'run' ? 'running' : 'waiting';
    if (g.total > 1 && g.failed) count.textContent += ` · ${g.failed} failed`;
    li.append(dot, name, count);
    els.stages.append(li);
  }
  const total = jobs.length || 1;
  const done = jobs.filter((j) => j.status === 'completed').length;
  const pct = Math.max(Number(els.bar.dataset.pct || 0), Math.round((done / total) * 100));
  els.bar.dataset.pct = String(pct);
  els.bar.style.width = `${pct}%`;
}

function renderRecent(runs) {
  els.recent.replaceChildren();
  els.recentCard.hidden = runs.length === 0;
  for (const run of runs.slice(0, 8)) {
    const li = document.createElement('li');
    const [label, kind] = runState(run);
    const pill = document.createElement('span');
    pill.className = `status-pill${kind ? ` ${kind}` : ''}`;
    pill.textContent = label;
    const text = document.createElement('span');
    text.textContent = `#${run.run_number} · ${new Date(run.created_at).toLocaleString()} · ${run.actor?.login || 'unknown'}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary';
    btn.textContent = 'View';
    btn.addEventListener('click', () => { watch(readConfigSafe(), run.id); });
    li.append(pill, text, btn);
    els.recent.append(li);
  }
}

/* ---------------- run lifecycle ---------------- */

function readConfigSafe() {
  try { return readConfig(); } catch (err) { showError(err.message); throw err; }
}

async function watch(cfg, runId) {
  const generation = ++watchGeneration;
  store.set('sessionStorage', 'wa.run', String(runId));
  currentRun = { id: runId, cfg };
  els.statusCard.hidden = false;
  els.resultRow.hidden = true;
  els.download.hidden = true;
  els.resultMsg.textContent = '';
  els.bar.dataset.pct = '0';
  els.bar.style.width = '0%';
  els.stages.replaceChildren();
  const startedAt = Date.now();

  for (;;) {
    if (generation !== watchGeneration) return;
    let run, jobs;
    try {
      run = await api(cfg, `/repos/${cfg.repo}/actions/runs/${runId}`);
      jobs = [];
      for (let page = 1; page <= 5; page++) {
        const data = await api(cfg, `/repos/${cfg.repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`);
        jobs = jobs.concat(data.jobs || []);
        if ((data.jobs || []).length < 100) break;
      }
    } catch (err) {
      showError(err.message);
      return;
    }
    if (generation !== watchGeneration) return;
    showError('');

    const [label, kind] = runState(run);
    setPill(els.runPill, label, kind);
    els.runMeta.textContent = `Run #${run.run_number} · started ${new Date(run.created_at).toLocaleString()} · ${run.actor?.login || ''}`;
    els.openRun.href = run.html_url;
    renderStages(jobs);

    if (run.status === 'completed') {
      els.bar.dataset.pct = '100';
      els.bar.style.width = '100%';
      els.resultRow.hidden = false;
      els.resultMsg.textContent = 'Looking for the report…';
      showDownload(cfg, runId, generation);
      refreshRecent(cfg);
      return;
    }
    if (Date.now() - startedAt > 3 * 60 * 60 * 1000) {
      showError('Stopped watching after 3 hours. Open the run on GitHub to see its state.');
      return;
    }
    await new Promise((r) => setTimeout(r, document.hidden ? 30000 : 6000));
  }
}

async function refreshRecent(cfg) {
  try { renderRecent(await listRuns(cfg, 8)); } catch { /* the list is a convenience */ }
}

async function connect() {
  showError('');
  let cfg;
  try { cfg = readConfig(); } catch (err) { showError(err.message); return null; }
  setPill(els.connPill, 'Checking…', '');
  try {
    currentUser = await api(cfg, '/user');
    const wf = await api(cfg, wfPath(cfg));
    if (wf.state && wf.state !== 'active') throw new ApiError(`The workflow is "${wf.state}" — enable it in the repository's Actions tab.`);
    saveSettings(cfg);
    setPill(els.connPill, `Connected as ${currentUser.login}`, 'pass');
    refreshRecent(cfg);
    return cfg;
  } catch (err) {
    setPill(els.connPill, 'Not connected', 'fail');
    showError(err.message);
    return null;
  }
}

async function startScan() {
  showError('');
  let cfg;
  try { cfg = readConfig(); } catch (err) { showError(err.message); return; }

  const entries = parseTargets(els.urls.value);
  const bad = [];
  for (const e of entries) {
    const reason = rejectReason(e);
    if (reason) bad.push({ value: e, reason });
  }
  showProblems(bad);
  if (bad.length) return;
  if (entries.length === 0 && !window.confirm('No URL entered. This will scan the repository\'s saved SITE_URLS list. Continue?')) return;

  els.run.disabled = true;
  els.runHint.textContent = 'Starting…';
  try {
    if (!currentUser) currentUser = await api(cfg, '/user');
    const repoInfo = await api(cfg, `/repos/${cfg.repo}`);
    const before = new Set((await listRuns(cfg, 20)).map((r) => r.id));

    const inputs = {};
    if (entries.length) inputs.target_urls = entries.join('\n');
    if (els.note.value.trim()) inputs.note = els.note.value.trim();
    const limit = Number(els.sitemapLimit.value);
    if (Number.isInteger(limit) && limit >= 1 && limit <= 100) inputs.sitemap_limit = String(limit);

    await api(cfg, `${wfPath(cfg)}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: repoInfo.default_branch || 'main', inputs }),
    });
    saveSettings(cfg);
    els.runHint.textContent = 'Scan requested — waiting for GitHub to start it…';

    let found = null;
    for (let attempt = 0; attempt < 30 && !found; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));
      const runs = await listRuns(cfg, 20);
      found = runs.find((r) => !before.has(r.id) && r.actor?.login === currentUser.login) || null;
    }
    if (!found) {
      els.runHint.textContent = '';
      showError('The scan was requested but GitHub has not shown a new run yet. Check the repository\'s Actions tab or the "Recent runs" list below.');
      refreshRecent(cfg);
      return;
    }
    els.runHint.textContent = '';
    watch(cfg, found.id);
  } catch (err) {
    els.runHint.textContent = '';
    showError(err.message);
  } finally {
    els.run.disabled = false;
  }
}

/* ---------------- report download ---------------- */

// The page cannot fetch the artifact itself: GitHub redirects artifact downloads
// to storage that sends no CORS headers, so a script's request is always
// blocked (confirmed on the first real run). Instead the artifact's own page
// URL is offered as a normal link — the browser follows it with the visitor's
// GitHub session, which is what the Actions UI does. This metadata call is
// allowed (api.github.com sends CORS headers).
const REPORT_ARTIFACT_NAMES = ['site-audit-report', 'report.html'];

async function showDownload(cfg, runId, generation) {
  els.download.hidden = true;
  try {
    const list = await api(cfg, `/repos/${cfg.repo}/actions/runs/${runId}/artifacts?per_page=100`);
    if (generation !== watchGeneration) return;
    const artifact = (list.artifacts || []).find((a) => REPORT_ARTIFACT_NAMES.includes(a.name) && !a.expired);
    if (!artifact) {
      els.resultMsg.textContent = 'No report is available for this run — it may have expired (reports are kept 90 days) or the run failed before the report step. Open the run on GitHub for details.';
      return;
    }
    const mb = artifact.size_in_bytes ? ` (${(artifact.size_in_bytes / 1048576).toFixed(1)} MB)` : '';
    els.download.href = `https://github.com/${cfg.repo}/actions/runs/${runId}/artifacts/${artifact.id}`;
    els.download.textContent = `Download report${mb}`;
    els.download.hidden = false;
    els.resultMsg.textContent = artifact.name === 'report.html'
      ? 'Opens GitHub\'s download — you need to be signed in to GitHub with access to the repository.'
      : 'Opens GitHub\'s download — you need to be signed in to GitHub with access to the repository. It arrives as a .zip: unzip it to get report.html.';
  } catch (err) {
    els.resultMsg.textContent = '';
    showError(err.message);
  }
}

/* ---------------- wiring ---------------- */

els.connect.addEventListener('click', connect);
els.run.addEventListener('click', startScan);
els.forget.addEventListener('click', () => {
  store.del('localStorage', 'wa.token');
  store.del('sessionStorage', 'wa.token');
  store.del('sessionStorage', 'wa.run');
  els.token.value = '';
  els.remember.checked = false;
  currentUser = null;
  watchGeneration++;
  els.statusCard.hidden = true;
  els.recentCard.hidden = true;
  setPill(els.connPill, '', '');
});

loadSettings();
(async () => {
  if (!els.token.value || !els.repo.value) return;
  const cfg = await connect();
  const resume = store.get('sessionStorage', 'wa.run');
  if (cfg && resume) watch(cfg, Number(resume));
})();

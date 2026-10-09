/* Lamblooket — teacher area: sign-in, library, set editor, pupil-view preview */
(function () {
'use strict';

const cfg = window.LAMBLOOKET;
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
const app = document.getElementById('app');

const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const nowIso = () => new Date().toISOString();

/* ---------- streak scoring ---------- */
const BASE = 100;
const TIERS = [
  { from: 1, m: 1, label: '1–2 in a row' },
  { from: 3, m: 1.5, label: '3–4 in a row' },
  { from: 5, m: 2, label: '5–7 in a row' },
  { from: 8, m: 3, label: '8+ in a row' }
];
const multFor = streak => { let m = 1; for (const t of TIERS) if (streak >= t.from) m = t.m; return m; };
const fmtMult = m => '×' + (Number.isInteger(m) ? m : m.toFixed(1));

/* ---------- state ---------- */
let me = null;              // signed-in user
let folders = [];
let sets = [];
let view = { name: 'library', folder: 'mine' };
let ui = {};
let game = null;

const mkQ = (q = '', answers = ['', '', '', ''], correct = 0) => ({ id: uid(), q, answers, correct });
const getSet = id => sets.find(s => s.id === id);
const mine = s => me && s.owner === me.id;
const folderName = id => (folders.find(f => f.id === id) || {}).name || 'Unfiled';
const validQ = q => q.q.trim() && q.answers.filter(a => String(a).trim()).length >= 2 && String(q.answers[q.correct] ?? '').trim();
const ownerLabel = s => (s.owner_email || '').split('@')[0] || 'a teacher';

/* ---------- feedback ---------- */
function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2200);
}
function saveStatus(state) {
  const s = document.getElementById('saved');
  if (!s) return;
  s.className = 'saved ' + (state === 'saved' ? 'on' : state === 'busy' ? 'busy' : state === 'bad' ? 'bad' : '');
  s.textContent = state === 'busy' ? 'Saving…' : state === 'bad' ? 'Not saved: check your connection' : 'Saved';
  if (state === 'saved') { clearTimeout(s._t); s._t = setTimeout(() => s.classList.remove('on'), 1400); }
}
function fail(what, error) {
  console.error(what, error);
  toast(`${what}. Check your connection and try again.`, true);
}

/* ---------- saving edits (debounced per set) ---------- */
const pending = new Map();
function queueSave(set) {
  set.updated_at = nowIso();
  clearTimeout(pending.get(set.id));
  saveStatus('busy');
  pending.set(set.id, setTimeout(() => flushSave(set), 700));
}
async function flushSave(set) {
  pending.delete(set.id);
  const { error } = await sb.from('sets')
    .update({ title: set.title, folder_id: set.folder_id, questions: set.questions })
    .eq('id', set.id);
  if (error) { saveStatus('bad'); console.error(error); return; }
  if (!pending.size) saveStatus('saved');
}
async function flushAll() {
  for (const [id, t] of pending) { clearTimeout(t); const s = getSet(id); if (s) await flushSave(s); }
}
window.addEventListener('beforeunload', e => { if (pending.size) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- maths rendering ---------- */
function typeset(el) {
  const MJ = window.MathJax;
  if (!el || !MJ || !MJ.startup || !MJ.startup.promise) return;
  MJ.startup.promise
    .then(() => { try { MJ.typesetClear && MJ.typesetClear([el]); } catch (e) {} return MJ.typesetPromise([el]); })
    .catch(() => {});
}
window.addEventListener('load', () => typeset(app));

/* ---------- sign-in ---------- */
function renderSignIn(msg) {
  app.innerHTML = `<div class="gate"><form class="gate-card" id="signin">
    <div class="mark" aria-label="Lamblooket">Lamb<span>l</span><span class="oo" aria-hidden="true"><i></i><i></i></span><span>ket</span></div>
    <h1 style="font-size:24px">Teacher sign-in</h1>
    <div class="field"><label for="email">School email</label><input class="in" id="email" type="email" autocomplete="username" required></div>
    <div class="field"><label for="password">Password</label><input class="in" id="password" type="password" autocomplete="current-password" required></div>
    <p class="err" id="signin-err">${esc(msg || '')}</p>
    <button class="btn primary" id="signin-btn">Sign in</button>
    <p class="foot">Need an account? Ask the Lamblooket admin to add you.<br><a href="./">Pupils: join a game here</a></p>
  </form></div>`;
  document.getElementById('email').focus();
}
async function onSignIn(e) {
  e.preventDefault();
  const btn = document.getElementById('signin-btn'), err = document.getElementById('signin-err');
  btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
  const { error } = await sb.auth.signInWithPassword({
    email: document.getElementById('email').value.trim(),
    password: document.getElementById('password').value
  });
  if (error) {
    btn.disabled = false; btn.textContent = 'Sign in';
    err.textContent = /invalid/i.test(error.message)
      ? 'That email and password don’t match. Check both and try again.'
      : 'Couldn’t sign in: ' + error.message;
  }
}

async function loadLibrary() {
  app.innerHTML = '<div class="loading">Loading your sets…</div>';
  const [f, s] = await Promise.all([
    sb.from('folders').select('id,name,created_at').order('name'),
    sb.from('sets').select('id,owner,owner_email,folder_id,title,questions,updated_at').order('updated_at', { ascending: false })
  ]);
  if (f.error || s.error) {
    console.error(f.error || s.error);
    app.innerHTML = `<div class="gate"><div class="gate-card"><h1 style="font-size:24px">Couldn’t load your sets</h1><p>Check your internet connection, then reload the page.</p><button class="btn primary" onclick="location.reload()">Reload</button></div></div>`;
    return;
  }
  folders = f.data;
  sets = s.data.map(x => ({ ...x, questions: Array.isArray(x.questions) ? x.questions : [] }));
  render();
}

/* ---------- shell ---------- */
function header() {
  return `<header class="top">
    <div class="mark" aria-label="Lamblooket">Lamb<span>l</span><span class="oo" aria-hidden="true"><i></i><i></i></span><span>ket</span></div>
    <span class="chip">Teacher</span>
    <span class="saved" id="saved">Saved</span>
    <span class="who">${esc(me.email)} <button class="btn small ghost" data-act="sign-out">Sign out</button></span>
  </header>`;
}
function render() {
  if (view.name !== 'play') stopTimer();
  if (view.name === 'library') app.innerHTML = `<div class="wrap">${header()}${renderLibrary()}</div>`;
  else if (view.name === 'edit') app.innerHTML = `<div class="wrap">${header()}${renderEditor()}</div>`;
  else if (view.name === 'play') app.innerHTML = `<div class="wrap">${renderPlay()}</div>`;
  typeset(app);
  const f = app.querySelector('[data-autofocus]'); if (f) f.focus();
}

/* ---------- library ---------- */
function setsFor(f) {
  if (f === 'mine') return sets.filter(mine);
  if (f === 'unfiled') return sets.filter(s => mine(s) && !s.folder_id);
  if (f === 'school') {
    const q = (ui.search || '').toLowerCase();
    return sets.filter(s => !mine(s) && (!q || (s.title || '').toLowerCase().includes(q) || ownerLabel(s).toLowerCase().includes(q)));
  }
  return sets.filter(s => mine(s) && s.folder_id === f);
}
function renderLibrary() {
  const f = view.folder;
  const list = setsFor(f).slice().sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const isFolder = !['mine', 'unfiled', 'school'].includes(f);
  const folderBtn = (id, name, plain) => `<button class="fold ${f === id ? 'on' : ''}" data-act="folder" data-id="${id}"><span class="lbl">${plain ? '' : '<span class="ic"></span>'}${esc(name)}</span><span class="n">${id === 'school' ? sets.filter(s => !mine(s)).length : setsFor(id).length}</span></button>`;
  const curName = f === 'mine' ? 'My sets' : f === 'unfiled' ? 'Unfiled' : f === 'school' ? 'Other teachers’ sets' : folderName(f);

  let rail = `<nav class="rail" aria-label="Folders"><h3>Library</h3>${folderBtn('mine', 'My sets', true)}${folderBtn('unfiled', 'Unfiled', true)}${folderBtn('school', 'Other teachers’ sets', true)}<h3>My folders</h3>`;
  rail += folders.map(x => folderBtn(x.id, x.name)).join('');
  rail += ui.newFolder
    ? `<form class="inline-form" data-form="new-folder"><label class="sr" for="new-folder-name">Folder name</label><input id="new-folder-name" placeholder="e.g. Year 8 set 4" data-autofocus maxlength="60"><button class="btn small primary">Add</button></form>`
    : `<button class="btn ghost small" data-act="new-folder" style="justify-content:flex-start">+ New folder</button>`;
  rail += `</nav>`;

  let head = `<div class="main-head"><div>`;
  if (isFolder && ui.renaming === f) {
    head += `<form class="inline-form" data-form="rename-folder" style="padding:0"><label class="sr" for="rename-folder">Folder name</label><input id="rename-folder" value="${esc(curName)}" data-autofocus maxlength="60"><button class="btn small primary">Rename</button><button type="button" class="btn small ghost" data-act="cancel">Cancel</button></form>`;
  } else head += `<h1>${esc(curName)}</h1>`;
  head += `<p>${f === 'school' ? 'Preview any set, or duplicate it into your own sets to edit it.' : `${list.length} ${list.length === 1 ? 'set' : 'sets'}`}</p></div><div class="head-acts">`;
  if (f === 'school') head += `<label class="sr" for="search">Search sets</label><input class="in search" id="search" type="search" placeholder="Search by name or teacher" value="${esc(ui.search || '')}">`;
  if (isFolder && ui.renaming !== f) head += `<button class="btn small ghost" data-act="rename-folder">Rename</button><button class="btn small ghost danger" data-act="ask-del-folder">Delete folder</button>`;
  if (f !== 'school') head += `<button class="btn primary" data-act="new-set">+ New set</button>`;
  head += `</div></div>`;
  if (isFolder && ui.confirmFolder === f) head += `<div class="confirm" style="margin-bottom:16px">Delete the folder “${esc(curName)}”? Its sets move to Unfiled. <button class="btn small danger" data-act="del-folder">Delete folder</button><button class="btn small ghost" data-act="cancel">Keep it</button></div>`;

  let body;
  if (!list.length) {
    body = f === 'school'
      ? `<div class="empty"><h2>${ui.search ? 'No matching sets' : 'No other teachers’ sets yet'}</h2><p>${ui.search ? 'Try a different search.' : 'When colleagues make sets, they appear here.'}</p></div>`
      : `<div class="empty"><h2>No sets here yet</h2><p>Make one from scratch, or paste questions straight from Excel.</p><button class="btn primary" data-act="new-set">+ New set</button></div>`;
  } else {
    body = `<div class="grid" id="set-grid">${list.map(cardHTML).join('')}</div>`;
  }
  return `<div class="lib">${rail}<section style="min-width:0">${head}${body}</section></div>`;
}
function cardHTML(s) {
  const n = s.questions.length, ok = s.questions.filter(validQ).length;
  const stripes = s.questions.slice(0, 12).map(q => `<span class="t${q.correct % 4}"></span>`).join('');
  const own = mine(s);
  let acts;
  if (ui.confirmSet === s.id) acts = `<div class="confirm">Delete this set for good? <button class="btn small danger" data-act="del-set" data-id="${s.id}">Delete</button><button class="btn small ghost" data-act="cancel">Keep</button></div>`;
  else acts = `<div class="acts"><button class="btn small primary" data-act="play" data-id="${s.id}" ${ok ? '' : 'disabled'}>▶ Preview</button>`
    + (own ? `<button class="btn small" data-act="edit" data-id="${s.id}">Edit</button>` : '')
    + `<button class="btn small ghost" data-act="dup" data-id="${s.id}">${own ? 'Duplicate' : 'Copy to my sets'}</button>`
    + (own ? `<button class="btn small ghost danger" data-act="ask-del-set" data-id="${s.id}">Delete</button>` : '')
    + `</div>`;
  return `<article class="card">
    <div class="stripes" aria-hidden="true">${stripes || '<span style="background:var(--line)"></span>'}</div>
    <h2>${esc(s.title || 'Untitled set')}</h2>
    <div class="meta"><span>${n} ${n === 1 ? 'question' : 'questions'}</span>${own ? `<span>${esc(folderName(s.folder_id))}</span>` : `<span>by ${esc(ownerLabel(s))}</span>`}${own && ok < n ? `<span style="color:var(--bad)">${n - ok} unfinished</span>` : ''}</div>
    ${acts}
  </article>`;
}

/* ---------- editor ---------- */
function renderEditor() {
  const s = getSet(view.setId);
  if (!s || !mine(s)) { view = { name: 'library', folder: 'mine' }; return renderLibrary(); }
  const opts = `<option value="">Unfiled</option>` + folders.map(f => `<option value="${f.id}" ${s.folder_id === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const ok = s.questions.filter(validQ).length;
  return `
  <div class="toolbar"><button class="btn ghost small" data-act="back">← All sets</button></div>
  <div class="ed-top">
    <div class="field"><label for="set-title">Set name</label><input id="set-title" class="title-in" data-field="title" value="${esc(s.title)}" placeholder="Untitled set" maxlength="80"></div>
    <div class="ed-row">
      <div class="field"><label for="set-folder">Folder</label><select id="set-folder" data-field="folder">${opts}</select></div>
      <button class="btn primary" data-act="play" data-id="${s.id}" ${ok ? '' : 'disabled'}>▶ Preview as pupil</button>
    </div>
  </div>
  <div class="toolbar">
    <button class="btn" data-act="toggle-import">${ui.importOpen ? 'Close import' : '⇩ Import questions'}</button>
    <span class="sp"></span>
    <span class="hint">Maths: wrap it in dollar signs, e.g. <code>$\\frac{3}{4}$</code>, <code>$x^2$</code>, <code>$\\sqrt{50}$</code></span>
  </div>
  ${ui.importOpen ? renderImport() : ''}
  <div class="qs" id="qs">${s.questions.map((q, i) => renderQ(q, i, s.questions.length)).join('')}
    <button class="add-q" data-act="add-q">+ Add question</button>
  </div>`;
}
function renderQ(q, i, total) {
  const bad = !validQ(q);
  const rows = q.answers.map((a, j) => `
    <div class="ans-row ${q.correct === j ? 'correct' : ''}">
      <label class="pick" for="c-${q.id}-${j}" title="Mark as correct answer"><input type="radio" id="c-${q.id}-${j}" name="cor-${q.id}" data-field="correct" data-i="${j}" ${q.correct === j ? 'checked' : ''}><span class="tag t${j}">${j + 1}</span></label>
      <label class="sr" for="a-${q.id}-${j}">Answer ${j + 1}</label><input type="text" id="a-${q.id}-${j}" data-field="ans" data-i="${j}" value="${esc(a)}" placeholder="Answer ${j + 1}">
      ${q.answers.length > 2 ? `<button class="btn ghost small" data-act="rm-ans" data-i="${j}" aria-label="Remove answer ${j + 1}">✕</button>` : '<span></span>'}
    </div>`).join('');
  return `<article class="q ${bad ? 'warn' : ''}" data-qid="${q.id}">
    <div class="q-edit">
      <div class="q-head"><span class="q-num">Q${i + 1}</span>${bad ? '<span class="q-warn">Needs a question and at least 2 answers</span>' : ''}<span class="sp"></span>
        <button class="btn ghost small" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="btn ghost small" data-act="down" ${i === total - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="btn ghost small danger" data-act="rm-q" aria-label="Delete question">Delete</button></div>
      <label class="sr" for="qt-${q.id}">Question text</label>
      <textarea id="qt-${q.id}" data-field="q" rows="2" placeholder="Type the question">${esc(q.q)}</textarea>
      ${rows}
      ${q.answers.length < 4 ? `<button class="btn ghost small" data-act="add-ans" style="align-self:flex-start">+ Add answer</button>` : ''}
    </div>
    <div class="q-prev">${previewHTML(q)}</div>
  </article>`;
}
function previewHTML(q) {
  return `<span class="lab">Pupil sees</span><div class="pv-q">${esc(q.q) || '<span style="color:var(--muted)">Question text</span>'}</div>
    <div class="pv-ans">${q.answers.map((a, j) => `<div class="t${j} ${q.correct === j ? 'c' : ''}"><span>${esc(a) || '…'}</span></div>`).join('')}</div>`;
}
function refreshQ(q) {
  const card = app.querySelector(`[data-qid="${q.id}"]`); if (!card) return;
  const pv = card.querySelector('.q-prev'); pv.innerHTML = previewHTML(q);
  clearTimeout(pv._t); pv._t = setTimeout(() => typeset(pv), 200);
  card.classList.toggle('warn', !validQ(q));
  const w = card.querySelector('.q-warn');
  if (!validQ(q) && !w) card.querySelector('.q-num').insertAdjacentHTML('afterend', '<span class="q-warn">Needs a question and at least 2 answers</span>');
  if (validQ(q) && w) w.remove();
  card.querySelectorAll('.ans-row').forEach((r, j) => r.classList.toggle('correct', q.correct === j));
}

/* ---------- import ---------- */
const EXAMPLE_ROWS = [
  ['What is $\\frac{1}{2}$ of 18?', '9', '6', '36', '', '1'],
  ['$7 \\times 8 =$', '54', '56', '', '', '2'],
  ['Which is a prime number?', '21', '27', '29', '33', '3']
];
function renderImport() {
  const tab = ui.importTab || 'paste';
  const r = ui.importResult;
  return `<section class="import" aria-label="Import questions">
    <div class="tabs"><button class="${tab === 'paste' ? 'on' : ''}" data-act="imp-tab" data-tab="paste">Paste from Excel</button><button class="${tab === 'file' ? 'on' : ''}" data-act="imp-tab" data-tab="file">Upload a file</button></div>
    ${tab === 'paste' ? `
      <p class="hint" style="margin:0">Copy rows from Excel and paste them here. One question per row: the question, then 2–4 answers, then the number of the correct answer.</p>
      <div class="fmt"><table><tr><th>Question</th><th>Answer 1</th><th>Answer 2</th><th>Answer 3</th><th>Answer 4</th><th>Correct #</th></tr>
        ${EXAMPLE_ROWS.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>
      <div class="ed-row"><button class="btn small ghost" data-act="copy-example">Copy these example rows</button><span class="hint" id="copy-msg"></span></div>
      <label class="sr" for="import-paste">Pasted rows</label>
      <textarea id="import-paste" placeholder="Paste your rows here">${esc(ui.importText || '')}</textarea>
      <div class="ed-row"><button class="btn primary" data-act="imp-check">Check rows</button></div>`
    : `
      <p class="hint" style="margin:0">Upload an .xlsx or .csv in the simple layout, or an untouched Blooket spreadsheet import template. Lamblooket recognises the Blooket layout automatically.</p>
      <label class="sr" for="import-file">Spreadsheet file</label>
      <input type="file" id="import-file" accept=".xlsx,.xls,.csv">`}
    ${r ? `<div class="result">
      <strong>${r.questions.length ? `Found ${r.questions.length} ${r.questions.length === 1 ? 'question' : 'questions'}${r.mode === 'blooket' ? ' (Blooket template)' : ''}.` : 'No questions found.'}</strong>
      ${r.warnings.length ? `<ul>${r.warnings.slice(0, 12).map(w => `<li>${esc(w)}</li>`).join('')}${r.warnings.length > 12 ? `<li>…and ${r.warnings.length - 12} more</li>` : ''}</ul>` : ''}
      ${r.questions.length ? `<div class="ed-row"><button class="btn primary small" data-act="imp-add">Add to the end of this set</button><button class="btn small" data-act="imp-replace">Replace all questions</button></div>` : ''}
    </div>` : ''}
  </section>`;
}
const cell = v => (v == null ? '' : String(v).trim());
function rowsToQuestions(rows) {
  const questions = [], warnings = [];
  rows = rows.map(r => (r || []).map(cell));
  const hIdx = rows.findIndex(r => r.some(c => /^question text$/i.test(c)));
  if (hIdx >= 0) {
    rows.slice(hIdx + 1).forEach((r, k) => {
      const rowNo = hIdx + k + 2, text = r[1] || '';
      if (!text) return;
      const pairs = [2, 3, 4, 5].map((c, pos) => [pos + 1, r[c] || '']).filter(p => p[1]);
      const nums = (r[7] || '').split(/[,;\s]+/).map(Number).filter(n => n >= 1 && n <= 4);
      if (pairs.length < 2) { warnings.push(`Row ${rowNo}: skipped, needs at least 2 answers.`); return; }
      const ci = pairs.findIndex(p => p[0] === nums[0]);
      if (ci < 0) { warnings.push(`Row ${rowNo}: skipped, the correct answer number is missing or points to a blank answer.`); return; }
      if (nums.length > 1) warnings.push(`Row ${rowNo}: listed several correct answers; kept answer ${nums[0]} only.`);
      questions.push(mkQ(text, pairs.map(p => p[1]), ci));
    });
    return { questions, warnings, mode: 'blooket' };
  }
  rows.forEach((r, k) => {
    const rowNo = k + 1;
    let last = r.length - 1; while (last >= 0 && !r[last]) last--;
    if (last < 0) return;
    const text = r[0], corr = r[last];
    if (!/^[1-4]$/.test(corr)) { if (k === 0) return; warnings.push(`Row ${rowNo}: skipped, the last cell should be the correct answer number (1–4).`); return; }
    const pairs = r.slice(1, last).map((a, pos) => [pos + 1, a]).filter(p => p[1]);
    if (!text) { warnings.push(`Row ${rowNo}: skipped, no question text.`); return; }
    if (pairs.length < 2) { warnings.push(`Row ${rowNo}: skipped, needs at least 2 answers.`); return; }
    if (pairs.length > 4) { warnings.push(`Row ${rowNo}: skipped, more than 4 answers.`); return; }
    const ci = pairs.findIndex(p => p[0] === Number(corr));
    if (ci < 0) { warnings.push(`Row ${rowNo}: skipped, correct answer ${corr} is blank.`); return; }
    questions.push(mkQ(text, pairs.map(p => p[1]), ci));
  });
  return { questions, warnings, mode: 'simple' };
}
function parsePaste(text) {
  const unq = c => { const m = c.match(/^"([\s\S]*)"$/); return m ? m[1].replace(/""/g, '"') : c; };
  return rowsToQuestions(text.replace(/\r/g, '').split('\n').map(l => l.split('\t').map(unq)));
}

/* ---------- play (solo preview of the pupil screen) ---------- */
function startGame(setId) {
  const s = getSet(setId);
  const qs = s.questions.filter(validQ).map(q => ({ ...q, answers: [...q.answers] }));
  game = { set: s, qs, order: [], cur: null, phase: 'setup', minutes: ui.lastMinutes ?? 10, score: 0, streak: 0, best: 0, answered: 0, correct: 0, stats: {}, endAt: null, last: null, lastGain: 0 };
  qs.forEach(q => (game.stats[q.id] = { seen: 0, right: 0, wrong: {} }));
  view = { ...view, name: 'play', setId };
  render();
}
function nextQ() {
  if (!game.order.length) {
    game.order = shuffle(game.qs.map((_, i) => i));
    if (game.qs.length > 1 && game.order[0] === game.last) game.order.push(game.order.shift());
  }
  const i = game.order.shift(); game.last = i; game.cur = game.qs[i];
  game.phase = 'question'; game.pick = null;
  renderPlayBody();
}
function answer(j) {
  if (game.phase !== 'question' || !game.cur || j >= game.cur.answers.length) return;
  const q = game.cur, st = game.stats[q.id];
  game.pick = j; game.answered++; st.seen++;
  if (j === q.correct) {
    game.streak++; game.best = Math.max(game.best, game.streak); game.correct++; st.right++;
    game.lastGain = Math.round(BASE * multFor(game.streak)); game.score += game.lastGain;
  } else {
    game.lostStreak = game.streak; game.streak = 0; game.lastGain = 0;
    st.wrong[j] = (st.wrong[j] || 0) + 1;
    game.lockUntil = Date.now() + 2000;
    setTimeout(() => {
      if (game && game.phase === 'feedback') {
        const b = document.getElementById('go');
        if (b) { b.disabled = false; b.classList.remove('locking'); b.querySelector('.lbl').textContent = 'Next question'; b.focus(); }
      }
    }, 2000);
  }
  game.phase = 'feedback';
  renderPlayBody();
}
function endGame() { if (!game) return; stopTimer(); game.phase = 'over'; renderPlayBody(); }
function stopTimer() { if (game && game.timer) { clearInterval(game.timer); game.timer = null; } }
const fmtTime = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function tick() {
  if (!game || !game.endAt) return;
  const left = game.endAt - Date.now();
  const el = document.getElementById('hud-time'); if (el) el.textContent = fmtTime(left);
  if (left <= 0) endGame();
}
function hud() {
  const nextM = multFor(game.streak + 1), curM = multFor(Math.max(1, game.streak));
  const flames = [1, 3, 5, 8].map(t => `<i class="${game.streak >= t ? 'on' : ''}"></i>`).join('');
  return `<div class="hud">
    <div class="stat"><div class="k">Time left</div><div class="v" id="hud-time">${game.endAt ? fmtTime(game.endAt - Date.now()) : '∞'}</div></div>
    <div class="stat"><div class="k">Points</div><div class="v">${game.score.toLocaleString('en-GB')}</div></div>
    <div class="stat"><div class="k">Streak</div><div class="v">${game.streak}<span class="flames" aria-hidden="true">${flames}</span></div></div>
    <div class="stat mult"><div class="k">${game.phase === 'question' ? 'Next correct' : 'Multiplier'}</div><div class="v">${fmtMult(game.phase === 'question' ? nextM : curM)}</div></div>
    <button class="btn" data-act="end-game" style="height:auto">End game</button>
  </div>`;
}
function renderPlay() {
  return `<div class="play"><div class="toolbar"><button class="btn ghost small" data-act="leave-play">← Back</button><span class="sp"></span><span class="chip">Pupil view preview</span></div><div id="play-body">${playBodyHTML()}</div></div>`;
}
function renderPlayBody() {
  const b = document.getElementById('play-body'); if (!b) return;
  b.innerHTML = playBodyHTML(); typeset(b);
  const f = b.querySelector('[data-autofocus]'); if (f) f.focus();
}
function answersHTML(q, done) {
  return `<div class="answers">${q.answers.map((a, j) => {
    let cls = `ans a${j}`;
    if (done) cls += j === q.correct ? ' right' : j === game.pick ? ' wrong' : ' dim';
    return `<button class="${cls}" data-act="answer" data-i="${j}" ${done ? 'disabled' : ''}><span class="key">${j + 1}</span><span>${esc(a)}</span></button>`;
  }).join('')}</div>`;
}
function playBodyHTML() {
  const g = game;
  if (g.phase === 'setup') {
    return `<div class="stage center pop"><div class="setup">
      <span class="qlabel">${esc(g.set.title || 'Untitled set')} · ${g.qs.length} questions, shuffled and repeated</span>
      <h1 style="font-size:clamp(30px,5vw,44px)">Ready to play?</h1>
      <p class="hint" style="max-width:52ch;margin:0">Every correct answer scores ${BASE} points, multiplied by your streak. A wrong answer resets the streak and pauses you for 2 seconds.</p>
      <div class="tiers">${TIERS.map(t => `<div class="tier"><b>${fmtMult(t.m)}</b><span>${t.label}</span></div>`).join('')}</div>
      <div class="ed-row" style="justify-content:center">
        <div class="field"><label for="game-length">Game length</label><select id="game-length">${[3, 5, 10, 15, 20, 0].map(m => `<option value="${m}" ${g.minutes === m ? 'selected' : ''}>${m ? m + ' minutes' : 'No time limit'}</option>`).join('')}</select></div>
        <button class="btn primary big-go" data-act="begin" data-autofocus>Start</button>
      </div></div></div>`;
  }
  if (g.phase === 'ready') {
    return hud() + `<div class="stage center pop"><span class="qlabel">Question ${g.answered + 1}</span><button class="btn primary big-go" data-act="show-q" data-autofocus>Show question</button><span class="hint">or press Enter</span></div>`;
  }
  if (g.phase === 'question') {
    return hud() + `<div class="stage pop"><span class="qlabel">Question ${g.answered + 1}</span><div class="qtext">${esc(g.cur.q)}</div>${answersHTML(g.cur, false)}<span class="hint">Click an answer, or press 1–${g.cur.answers.length}</span></div>`;
  }
  if (g.phase === 'feedback') {
    const right = g.pick === g.cur.correct;
    const locked = !right && Date.now() < g.lockUntil;
    const verdict = right
      ? `<div class="verdict good pop"><div><h3>Correct! +${g.lastGain}</h3><p>Streak ${g.streak} · ${fmtMult(multFor(g.streak))}</p></div>`
      : `<div class="verdict bad pop"><div><h3>Not quite</h3><p>The answer is highlighted.${g.lostStreak > 1 ? ` Streak of ${g.lostStreak} lost.` : ''}</p></div>`;
    return hud() + `<div class="stage"><span class="qlabel">Question ${g.answered}</span><div class="qtext">${esc(g.cur.q)}</div>${answersHTML(g.cur, true)}
      ${verdict}<button class="btn primary go ${locked ? 'locking' : ''}" id="go" data-act="next" ${locked ? 'disabled' : 'data-autofocus'}><span class="lbl">${locked ? 'Wait a moment…' : 'Next question'}</span><span class="bar"></span></button></div></div>`;
  }
  if (g.phase === 'over') {
    const acc = g.answered ? Math.round(100 * g.correct / g.answered) : 0;
    const rows = g.qs.map(q => {
      const st = g.stats[q.id], pct = st.seen ? Math.round(100 * st.right / st.seen) : null;
      const topWrong = Object.entries(st.wrong).sort((a, b) => b[1] - a[1])[0];
      return `<tr><td>${esc(q.q)}</td><td class="num">${st.seen}</td><td class="num">${pct == null ? '–' : pct + '%'}</td><td>${pct == null ? '' : `<div class="meter"><i style="width:${pct}%"></i></div>`}</td><td>${topWrong ? esc(q.answers[topWrong[0]]) : '<span style="color:var(--muted)">–</span>'}</td></tr>`;
    }).join('');
    return `<div class="stage pop">
      <div style="display:flex;justify-content:space-between;align-items:end;gap:12px;flex-wrap:wrap"><div><span class="qlabel">Game over · ${esc(g.set.title || 'Untitled set')}</span><div class="hero-n">${g.score.toLocaleString('en-GB')}</div><span class="hint">points</span></div>
        <div class="ed-row"><button class="btn primary" data-act="again">Play again</button><button class="btn" data-act="leave-play">Back</button></div></div>
      <div class="summary">
        <div class="stat"><div class="k">Answered</div><div class="v">${g.answered}</div></div>
        <div class="stat"><div class="k">Correct</div><div class="v">${g.correct}</div></div>
        <div class="stat"><div class="k">Accuracy</div><div class="v">${acc}%</div></div>
        <div class="stat"><div class="k">Best streak</div><div class="v">${g.best}</div></div>
      </div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Question</th><th>Seen</th><th>Correct</th><th></th><th>Most common wrong answer</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  }
  return '';
}

/* ---------- database actions ---------- */
async function createFolder(name) {
  const { data, error } = await sb.from('folders').insert({ name }).select('id,name,created_at').single();
  if (error) return fail('Couldn’t create the folder', error);
  folders.push(data); folders.sort((a, b) => a.name.localeCompare(b.name));
  view.folder = data.id; ui = {}; render();
}
async function renameFolder(id, name) {
  const { error } = await sb.from('folders').update({ name }).eq('id', id);
  if (error) return fail('Couldn’t rename the folder', error);
  folders.find(f => f.id === id).name = name; ui = {}; render();
}
async function deleteFolder(id) {
  const { error } = await sb.from('folders').delete().eq('id', id);
  if (error) return fail('Couldn’t delete the folder', error);
  folders = folders.filter(f => f.id !== id);
  sets.forEach(s => { if (s.folder_id === id) s.folder_id = null; });
  view.folder = 'mine'; ui = {}; render();
}
async function insertSet(row) {
  const { data, error } = await sb.from('sets').insert(row).select('id,owner,owner_email,folder_id,title,questions,updated_at').single();
  if (error) { fail('Couldn’t save the new set', error); return null; }
  sets.unshift(data);
  return data;
}
async function deleteSet(id) {
  clearTimeout(pending.get(id)); pending.delete(id);
  const { error } = await sb.from('sets').delete().eq('id', id);
  if (error) return fail('Couldn’t delete the set', error);
  sets = sets.filter(s => s.id !== id); ui = {}; render();
}

/* ---------- events ---------- */
app.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
  const act = t.dataset.act, id = t.dataset.id;
  const set = view.setId ? getSet(view.setId) : null;
  const card = t.closest('[data-qid]');
  const q = card && set ? set.questions.find(x => x.id === card.dataset.qid) : null;
  switch (act) {
    case 'sign-out': await flushAll(); await sb.auth.signOut(); break;
    case 'folder': view.folder = id; ui = {}; render(); break;
    case 'new-folder': ui = { newFolder: true }; render(); break;
    case 'rename-folder': ui = { renaming: view.folder }; render(); break;
    case 'ask-del-folder': ui = { confirmFolder: view.folder }; render(); break;
    case 'del-folder': t.disabled = true; await deleteFolder(view.folder); break;
    case 'cancel': ui = { search: ui.search }; render(); break;
    case 'new-set': {
      t.disabled = true;
      const fid = !['mine', 'unfiled', 'school'].includes(view.folder) ? view.folder : null;
      const s = await insertSet({ title: '', folder_id: fid, questions: [mkQ()] });
      t.disabled = false;
      if (!s) return;
      view = { name: 'edit', setId: s.id, folder: view.folder }; ui = {}; render();
      const el = document.getElementById('set-title'); if (el) el.focus();
      break;
    }
    case 'edit': view = { name: 'edit', setId: id, folder: view.folder }; ui = {}; render(); break;
    case 'dup': {
      t.disabled = true;
      const s = getSet(id);
      const copy = await insertSet({
        title: mine(s) ? (s.title || 'Untitled set') + ' (copy)' : (s.title || 'Untitled set'),
        folder_id: mine(s) ? s.folder_id : null,
        questions: s.questions.map(x => ({ ...x, id: uid(), answers: [...x.answers] }))
      });
      if (copy) { toast(mine(s) ? 'Duplicated' : 'Copied to My sets'); render(); }
      else t.disabled = false;
      break;
    }
    case 'ask-del-set': ui = { confirmSet: id, search: ui.search }; render(); break;
    case 'del-set': t.disabled = true; await deleteSet(id); break;
    case 'play': {
      const back = { ...view };
      ui = { lastMinutes: ui.lastMinutes, search: ui.search };
      startGame(id); view.returnTo = back;
      break;
    }
    case 'back': view = { name: 'library', folder: view.folder || 'mine' }; ui = {}; render(); break;
    case 'add-q':
      set.questions.push(mkQ()); queueSave(set); render();
      { const qs = app.querySelectorAll('.q textarea'), last = qs[qs.length - 1]; if (last) { last.focus(); last.scrollIntoView({ block: 'center' }); } }
      break;
    case 'rm-q': set.questions = set.questions.filter(x => x !== q); queueSave(set); render(); break;
    case 'up': case 'down': {
      const i = set.questions.indexOf(q), j = act === 'up' ? i - 1 : i + 1;
      [set.questions[i], set.questions[j]] = [set.questions[j], set.questions[i]];
      queueSave(set); render(); break;
    }
    case 'add-ans':
      q.answers.push(''); queueSave(set); render();
      { const el = document.getElementById(`a-${q.id}-${q.answers.length - 1}`); if (el) el.focus(); }
      break;
    case 'rm-ans': {
      const j = +t.dataset.i; q.answers.splice(j, 1);
      if (q.correct === j) q.correct = 0; else if (q.correct > j) q.correct--;
      queueSave(set); render(); break;
    }
    case 'toggle-import': ui.importOpen = !ui.importOpen; ui.importResult = null; render(); break;
    case 'imp-tab': ui.importTab = t.dataset.tab; ui.importResult = null; render(); break;
    case 'copy-example': {
      const txt = EXAMPLE_ROWS.map(r => r.join('\t')).join('\n'), msg = document.getElementById('copy-msg');
      const fallback = () => { const ta = document.getElementById('import-paste'); ta.value = txt; ta.select(); ui.importText = txt; if (msg) msg.textContent = 'Copying is blocked here, so the rows are in the box below instead.'; };
      try { navigator.clipboard.writeText(txt).then(() => { if (msg) msg.textContent = 'Copied. Paste into Excel to start your own.'; }, fallback); } catch (err) { fallback(); }
      break;
    }
    case 'imp-check': ui.importText = document.getElementById('import-paste').value; ui.importResult = parsePaste(ui.importText); render(); break;
    case 'imp-add': case 'imp-replace': {
      const blankOnly = set.questions.length === 1 && !set.questions[0].q.trim() && !set.questions[0].answers.some(a => a.trim());
      set.questions = act === 'imp-replace' || blankOnly ? ui.importResult.questions : set.questions.concat(ui.importResult.questions);
      const n = ui.importResult.questions.length;
      ui = {}; queueSave(set); render(); toast(`Added ${n} ${n === 1 ? 'question' : 'questions'}`);
      break;
    }
    case 'begin': {
      game.minutes = +document.getElementById('game-length').value; ui.lastMinutes = game.minutes;
      game.endAt = game.minutes ? Date.now() + game.minutes * 60000 : null;
      game.timer = setInterval(tick, 250); game.phase = 'ready'; renderPlayBody(); break;
    }
    case 'show-q': nextQ(); break;
    case 'answer': answer(+t.dataset.i); break;
    case 'next': if (Date.now() >= (game.lockUntil || 0)) nextQ(); break;
    case 'end-game': endGame(); break;
    case 'again': { const back = view.returnTo; startGame(game.set.id); view.returnTo = back; break; }
    case 'leave-play': stopTimer(); game = null; view = view.returnTo || { name: 'library', folder: 'mine' }; delete view.returnTo; ui = { search: ui.search }; render(); break;
  }
});

app.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.id === 'signin') return onSignIn(e);
  const form = e.target.dataset.form;
  if (form === 'new-folder') {
    const name = document.getElementById('new-folder-name').value.trim();
    if (name) createFolder(name); else { ui = {}; render(); }
  }
  if (form === 'rename-folder') {
    const name = document.getElementById('rename-folder').value.trim();
    if (name) renameFolder(view.folder, name); else { ui = {}; render(); }
  }
});

app.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'search') {
    ui.search = t.value;
    const grid = document.getElementById('set-grid'), list = setsFor('school');
    if (grid && list.length) { grid.innerHTML = list.map(cardHTML).join(''); typeset(grid); }
    else { const pos = t.selectionStart; render(); const s = document.getElementById('search'); s.focus(); s.setSelectionRange(pos, pos); }
    return;
  }
  const field = t.dataset.field;
  if (view.name !== 'edit' || !field) return;
  const set = getSet(view.setId);
  if (field === 'title') { set.title = t.value; queueSave(set); return; }
  const card = t.closest('[data-qid]'); if (!card) return;
  const q = set.questions.find(x => x.id === card.dataset.qid);
  if (field === 'q') q.q = t.value;
  if (field === 'ans') q.answers[+t.dataset.i] = t.value;
  queueSave(set); refreshQ(q);
});

app.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'import-file' && t.files[0]) {
    if (!window.XLSX) { toast('The spreadsheet reader is still loading. Try again in a moment.', true); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
        ui.importResult = rowsToQuestions(rows);
      } catch (err) {
        ui.importResult = { questions: [], warnings: ['That file could not be read. Save it as .xlsx or .csv and try again.'] };
      }
      render();
    };
    reader.readAsArrayBuffer(t.files[0]);
    return;
  }
  if (view.name !== 'edit') return;
  const set = getSet(view.setId), field = t.dataset.field;
  if (field === 'folder') { set.folder_id = t.value || null; queueSave(set); }
  if (field === 'correct') {
    const q = set.questions.find(x => x.id === t.closest('[data-qid]').dataset.qid);
    q.correct = +t.dataset.i; queueSave(set); refreshQ(q);
  }
});

document.addEventListener('keydown', e => {
  if (view.name !== 'play' || !game) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
  if (game.phase === 'question' && /^[1-4]$/.test(e.key)) { e.preventDefault(); answer(+e.key - 1); }
  else if ((e.key === 'Enter' || e.key === ' ') && (game.phase === 'ready' || game.phase === 'feedback')) {
    if (tag === 'BUTTON') return; // the focused button handles it
    e.preventDefault();
    if (game.phase === 'ready' || Date.now() >= (game.lockUntil || 0)) nextQ();
  }
});

/* ---------- boot ---------- */
let booted = false;
sb.auth.onAuthStateChange((event, session) => {
  const user = session && session.user;
  if (user && (!me || me.id !== user.id)) {
    me = user; view = { name: 'library', folder: 'mine' }; ui = {};
    setTimeout(loadLibrary, 0); // run outside the auth callback
  } else if (!user) {
    me = null; folders = []; sets = []; game = null;
    renderSignIn(booted && event === 'SIGNED_OUT' ? 'You’ve signed out.' : '');
  }
  booted = true;
});
})();

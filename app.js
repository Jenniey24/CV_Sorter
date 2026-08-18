/* app.js — state + UI wiring for the CV intake manifest.
   Auth lives in auth.js / login.html now — this file assumes the
   visitor is already authed (console.html's guard() runs first). */

const el = (id) => document.getElementById(id);

el("btnLogout").addEventListener("click", () => {
  AUTH.logout();
  AUTH.goToLogin();
});

const STATUSES = ["New", "Shortlisted", "Interviewing", "Rejected", "Hired"];
const SOURCES = ["Direct application", "Referral", "LinkedIn", "Job board", "Agency", "Other"];

const state = {
  candidates: [],   // see shape below
  queue: [],
  nextId: 1,
  knownEmails: new Set(),
  knownPhones: new Set(),
  knownFetched: false,
  view: "table",    // 'table' | 'kanban'
  selected: new Set(),
  drawerId: null,
};

/* candidate shape:
   {
     id, name, email, phone, country, linkedin, yearsExp, tags: [],
     score, rating, scoreHits, scoreMisses,
     status, source, interviewDate, starred,
     notesLog: [{ ts, text }],
     fileName, rawText, file, pushed,
     duplicateInBatch, duplicateInSheet, duplicate,
   }
*/

// ---------- autosave (this browser only — File blobs can't be persisted) ----------
const AUTOSAVE_KEY = "cv-sorter-manifest";
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}
function saveState() {
  try {
    const serializable = state.candidates.map(c => {
      const { file, ...rest } = c;
      return rest;
    });
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ nextId: state.nextId, candidates: serializable }));
  } catch (err) {
    console.warn("Autosave failed (storage may be full)", err);
  }
}
function restoreState() {
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.candidates) && data.candidates.length) {
      state.candidates = data.candidates.map(c => ({ ...c, file: null, fileMissing: true }));
      state.nextId = data.nextId || (Math.max(0, ...state.candidates.map(c => c.id)) + 1);
      toast(`Restored ${state.candidates.length} candidate${state.candidates.length === 1 ? "" : "s"} from your last session`);
    }
  } catch (err) {
    console.warn("Couldn't restore autosaved manifest", err);
  }
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- dropzone / file intake ----------
const dropzone = el("dropzone");
const fileInput = el("fileInput");
let pendingFiles = [];

["dragenter", "dragover"].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
  })
);
dropzone.addEventListener("drop", e => {
  const files = Array.from(e.dataTransfer.files).filter(isSupportedFile);
  addToQueue(files);
});
fileInput.addEventListener("change", e => {
  const files = Array.from(e.target.files).filter(isSupportedFile);
  addToQueue(files);
  fileInput.value = "";
});

function isSupportedFile(f) {
  return /\.(pdf|docx)$/i.test(f.name);
}

function addToQueue(files) {
  if (!files.length) return;
  files.forEach(f => pendingFiles.push({ file: f, status: "pending" }));
  renderQueue();
}

function renderQueue() {
  const listWrap = el("queueList");
  const items = el("queueItems");
  listWrap.hidden = pendingFiles.length === 0;
  el("queueCount").textContent = `${pendingFiles.length} file${pendingFiles.length === 1 ? "" : "s"} queued`;
  items.innerHTML = "";
  pendingFiles.forEach(p => {
    const li = document.createElement("li");
    li.className = p.status;
    li.innerHTML = `<span>${escapeHtml(p.file.name)}</span><span class="qi-status">${statusLabel(p.status)}</span>`;
    items.appendChild(li);
  });
}
function statusLabel(s) {
  return s === "pending" ? "queued" : s === "done" ? "sorted" : "couldn't read";
}

async function fetchKnownFromSheet() {
  const url = getSavedUrl();
  const secret = getSavedSecret();
  if (!url) return;
  try {
    const res = await sheetRequest(url, { action: "list", secret });
    if (res && res.ok) {
      state.knownEmails = new Set((res.emails || []).map(e => e.toLowerCase()));
      state.knownPhones = new Set(res.phones || []);
      state.knownFetched = true;
    }
  } catch (err) {
    console.warn("Couldn't fetch known candidates from sheet", err);
  }
}

el("btnProcess").addEventListener("click", processQueue);

async function processQueue() {
  if (!pendingFiles.length) return;
  el("btnProcess").disabled = true;

  if (getSavedUrl() && !state.knownFetched) {
    el("btnProcess").textContent = "Checking sheet history…";
    await fetchKnownFromSheet();
  }

  const total = pendingFiles.length;
  let done = 0;

  for (const item of pendingFiles) {
    el("btnProcess").textContent = `Sorting ${done + 1} of ${total}…`;
    try {
      const text = await fileToText(item.file);
      const fields = extractFields(text, item.file.name);
      state.candidates.push({
        id: state.nextId++,
        name: fields.name,
        email: fields.email,
        phone: fields.phone,
        country: fields.country,
        linkedin: fields.linkedin,
        yearsExp: fields.yearsExp,
        tags: fields.tags || [],
        score: null,
        rating: null,
        status: "New",
        source: "",
        interviewDate: "",
        starred: false,
        notesLog: [],
        fileName: item.file.name,
        rawText: text,
        file: item.file,
        fileMissing: false,
        pushed: false,
      });
      item.status = "done";
    } catch (err) {
      console.error(err);
      item.status = "error";
    }
    done++;
    renderQueue();
  }

  el("btnProcess").disabled = false;
  el("btnProcess").textContent = "Sort them out";
  pendingFiles = pendingFiles.filter(p => p.status !== "done");
  renderQueue();
  flagDuplicates();
  renderAll();
  scheduleSave();
  toast(`Sorted — ${state.candidates.length} candidate${state.candidates.length === 1 ? "" : "s"} in the manifest`);
}

// ---------- duplicate detection ----------
function flagDuplicates() {
  const byEmail = {};
  const byPhone = {};
  state.candidates.forEach(c => {
    if (c.email) (byEmail[c.email.toLowerCase()] ??= []).push(c.id);
    if (c.phone) (byPhone[c.phone] ??= []).push(c.id);
  });
  state.candidates.forEach(c => {
    const emailDupBatch = c.email && byEmail[c.email.toLowerCase()].length > 1;
    const phoneDupBatch = c.phone && byPhone[c.phone].length > 1;
    const emailDupSheet = c.email && state.knownEmails.has(c.email.toLowerCase()) && !c.pushed;
    const phoneDupSheet = c.phone && state.knownPhones.has(c.phone) && !c.pushed;
    c.duplicateInBatch = Boolean(emailDupBatch || phoneDupBatch);
    c.duplicateInSheet = Boolean(emailDupSheet || phoneDupSheet);
    c.duplicate = c.duplicateInBatch || c.duplicateInSheet;
  });
}

// ---------- scoring against a job description ----------
function parseJD(jdRaw) {
  const lines = jdRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const musts = [];
  const nice = [];
  let reqYears = null;
  lines.forEach(line => {
    const yearsMatch = line.match(/(\d{1,2})\+?\s*(?:years?|yrs?)/i);
    if (yearsMatch && /experience|exp\b/i.test(line)) {
      reqYears = Math.max(reqYears ?? 0, parseInt(yearsMatch[1], 10));
      return;
    }
    if (/^!/.test(line) || /^must:?/i.test(line)) {
      const cleaned = line.replace(/^!/, "").replace(/^must:?/i, "").trim();
      if (cleaned) musts.push(cleaned);
    } else {
      const cleaned = line.replace(/^nice:?/i, "").trim();
      if (cleaned) nice.push(cleaned);
    }
  });
  return { musts, nice, reqYears };
}

el("btnScore").addEventListener("click", () => {
  const jdRaw = el("jdInput").value.trim();
  if (!jdRaw) { toast("Paste a job description or keywords first"); return; }
  const { musts, nice, reqYears } = parseJD(jdRaw);
  if (!musts.length && !nice.length && reqYears === null) {
    toast("Couldn't find any keywords in that text");
    return;
  }

  state.candidates.forEach(c => {
    const text = (c.rawText || "").toLowerCase();
    const mustHits = musts.filter(k => text.includes(k.toLowerCase()));
    const niceHits = nice.filter(k => text.includes(k.toLowerCase()));
    const totalWeight = musts.length * 2 + nice.length;
    const gotWeight = mustHits.length * 2 + niceHits.length;
    let pct = totalWeight ? Math.round((gotWeight / totalWeight) * 100) : 100;

    if (musts.length && mustHits.length < musts.length) {
      pct = Math.min(pct, Math.round((mustHits.length / musts.length) * 60));
    }
    if (reqYears !== null && c.yearsExp !== null && c.yearsExp !== undefined) {
      pct = c.yearsExp >= reqYears ? Math.min(100, pct + 5) : Math.max(0, pct - 15);
    }

    c.score = Math.max(0, Math.min(100, pct));
    c.rating = c.score === 0 ? 0 : Math.max(1, Math.round(c.score / 10));
    c.scoreHits = [...mustHits, ...niceHits];
    c.scoreMisses = [...musts.filter(k => !mustHits.includes(k)), ...nice.filter(k => !niceHits.includes(k))];
  });

  el("sortSelect").value = "score";
  renderAll();
  scheduleSave();
  const yearsNote = reqYears !== null ? ` (${reqYears}+ yrs weighted)` : "";
  toast(`Rated against ${musts.length} must-have + ${nice.length} nice-to-have${yearsNote}`);
});

// ---------- view toggle ----------
el("viewTable").addEventListener("click", () => setView("table"));
el("viewKanban").addEventListener("click", () => setView("kanban"));
function setView(v) {
  state.view = v;
  el("viewTable").classList.toggle("active", v === "table");
  el("viewKanban").classList.toggle("active", v === "kanban");
  renderAll();
}

// ---------- shared filter/sort ----------
function getFilteredSorted() {
  const q = el("searchInput").value.trim().toLowerCase();
  const statusFilter = el("statusFilter").value;
  const sortBy = el("sortSelect").value;

  let rows = state.candidates.filter(c => {
    if (statusFilter && c.status !== statusFilter) return false;
    if (!q) return true;
    const hay = `${c.name} ${c.email} ${c.phone} ${c.country} ${(c.tags || []).join(" ")} ${c.rawText}`.toLowerCase();
    return hay.includes(q);
  });

  rows = rows.slice();
  if (sortBy === "score") rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  else if (sortBy === "name") rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (sortBy === "country") rows.sort((a, b) => (a.country || "").localeCompare(b.country || ""));
  else if (sortBy === "starred") rows.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
  return rows;
}

function renderAll() {
  el("emptyState").hidden = state.candidates.length > 0;
  const showTable = state.candidates.length > 0 && state.view === "table";
  const showKanban = state.candidates.length > 0 && state.view === "kanban";
  el("tableWrap").hidden = !showTable;
  el("kanbanWrap").hidden = !showKanban;
  if (showTable) renderTable();
  if (showKanban) renderKanban();
  updateFootStats();
  updateBulkBar();
}

// ---------- table rendering ----------
const manifestBody = el("manifestBody");

function renderTable() {
  const rows = getFilteredSorted();
  manifestBody.innerHTML = "";

  rows.forEach((c, i) => {
    const tr = document.createElement("tr");
    if (c.duplicate) tr.classList.add("dup-flag");

    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-check" data-id="${c.id}" ${state.selected.has(c.id) ? "checked" : ""}></td>
      <td class="col-idx">${String(i + 1).padStart(3, "0")}</td>
      <td class="col-star"><button class="star-btn ${c.starred ? "on" : ""}" data-id="${c.id}" title="Star">${c.starred ? "★" : "☆"}</button></td>
      <td contenteditable="true" data-field="name" data-id="${c.id}">${escapeHtml(c.name)}${dupTag(c)}</td>
      <td contenteditable="true" class="mono-cell" data-field="email" data-id="${c.id}">${escapeHtml(c.email)}</td>
      <td contenteditable="true" class="mono-cell" data-field="phone" data-id="${c.id}">${escapeHtml(c.phone)}</td>
      <td contenteditable="true" data-field="country" data-id="${c.id}">${escapeHtml(c.country)}</td>
      <td>${scorePill(c)}</td>
      <td>${statusSelect(c)}</td>
      <td class="tags-cell">${tagChips(c)}</td>
      <td class="file-cell" title="${escapeHtml(c.fileName)}">${escapeHtml(c.fileName)}</td>
      <td class="col-actions">
        <button class="btn-icon" data-action="open" data-id="${c.id}" title="Open detail">⤢</button>
        <button class="row-delete" data-id="${c.id}" title="Remove from manifest">✕</button>
      </td>
    `;
    manifestBody.appendChild(tr);
  });

  el("checkAll").checked = rows.length > 0 && rows.every(c => state.selected.has(c.id));
}

function dupTag(c) {
  if (c.duplicateInSheet) return '<span class="dup-tag dup-tag-sheet">already in sheet</span>';
  if (c.duplicateInBatch) return '<span class="dup-tag">dup in this batch</span>';
  return "";
}

function scorePill(c) {
  if (c.rating === null || c.rating === undefined) return "—";
  const cls = c.rating > 0 ? "" : "zero";
  return `<span class="score-pill ${cls}" title="${c.score}% keyword match">${c.rating}/10</span>`;
}

function statusSelect(c) {
  return `<select class="status-select" data-id="${c.id}">
    ${STATUSES.map(o => `<option value="${o}" ${o === c.status ? "selected" : ""}>${o}</option>`).join("")}
  </select>`;
}

function tagChips(c) {
  const tags = c.tags || [];
  if (!tags.length) return '<span class="tags-empty">—</span>';
  const shown = tags.slice(0, 3);
  const extra = tags.length - shown.length;
  return shown.map(t => `<span class="chip">${escapeHtml(t)}</span>`).join("") +
    (extra > 0 ? `<span class="chip chip-more">+${extra}</span>` : "");
}

manifestBody.addEventListener("blur", e => {
  const cell = e.target;
  if (!cell.matches("[contenteditable]")) return;
  const id = Number(cell.dataset.id);
  const field = cell.dataset.field;
  const c = state.candidates.find(c => c.id === id);
  if (!c) return;
  c[field] = cell.textContent.replace(/possible dup/i, "").trim();
  if (field === "email" || field === "phone") flagDuplicates();
  scheduleSave();
}, true);

manifestBody.addEventListener("change", e => {
  if (e.target.matches(".status-select")) {
    const id = Number(e.target.dataset.id);
    const c = state.candidates.find(c => c.id === id);
    if (c) { c.status = e.target.value; scheduleSave(); }
  }
  if (e.target.matches(".row-check")) {
    const id = Number(e.target.dataset.id);
    if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
    updateBulkBar();
  }
});

manifestBody.addEventListener("click", e => {
  if (e.target.matches(".row-delete")) {
    const id = Number(e.target.dataset.id);
    removeCandidate(id, true);
  }
  if (e.target.matches(".star-btn")) {
    const id = Number(e.target.dataset.id);
    const c = state.candidates.find(c => c.id === id);
    if (c) { c.starred = !c.starred; renderAll(); scheduleSave(); }
  }
  if (e.target.matches('[data-action="open"]')) {
    openDrawer(Number(e.target.dataset.id));
  }
});

function removeCandidate(id, confirmFirst) {
  const c = state.candidates.find(c => c.id === id);
  if (!c) return;
  if (confirmFirst && !confirm(`Remove ${c.name || c.fileName} from the manifest? This only removes it from this table — the original file on your computer is untouched, and nothing already pushed to the sheet is deleted.`)) {
    return;
  }
  state.candidates = state.candidates.filter(c => c.id !== id);
  state.selected.delete(id);
  flagDuplicates();
  renderAll();
  scheduleSave();
}

el("checkAll").addEventListener("change", e => {
  const rows = getFilteredSorted();
  if (e.target.checked) rows.forEach(c => state.selected.add(c.id));
  else rows.forEach(c => state.selected.delete(c.id));
  renderTable();
  updateBulkBar();
});

// ---------- bulk actions ----------
function updateBulkBar() {
  const bar = el("bulkBar");
  const count = state.selected.size;
  bar.hidden = count === 0;
  el("bulkCount").textContent = `${count} selected`;
}
el("btnBulkApplyStatus").addEventListener("click", () => {
  const status = el("bulkStatus").value;
  if (!status) { toast("Pick a status first"); return; }
  state.candidates.forEach(c => { if (state.selected.has(c.id)) c.status = status; });
  renderAll();
  scheduleSave();
  toast(`Set ${state.selected.size} candidate${state.selected.size === 1 ? "" : "s"} to ${status}`);
});
el("btnBulkDelete").addEventListener("click", () => {
  if (!state.selected.size) return;
  if (!confirm(`Remove ${state.selected.size} selected candidate(s) from the manifest?`)) return;
  state.candidates = state.candidates.filter(c => !state.selected.has(c.id));
  state.selected.clear();
  flagDuplicates();
  renderAll();
  scheduleSave();
});
el("btnBulkClear").addEventListener("click", () => {
  state.selected.clear();
  renderAll();
});

// ---------- kanban view ----------
function renderKanban() {
  const wrap = el("kanbanWrap");
  const rows = getFilteredSorted();
  wrap.innerHTML = STATUSES.map(status => {
    const cards = rows.filter(c => c.status === status);
    return `
      <div class="kanban-col" data-status="${status}">
        <div class="kanban-col-head">${status} <span class="kanban-count">${cards.length}</span></div>
        <div class="kanban-col-body" data-status="${status}">
          ${cards.map(kanbanCard).join("") || '<p class="kanban-empty">No candidates</p>'}
        </div>
      </div>
    `;
  }).join("");

  wrap.querySelectorAll(".kanban-card").forEach(card => {
    card.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("click", e => {
      if (e.target.closest(".star-btn")) return;
      openDrawer(Number(card.dataset.id));
    });
    card.querySelector(".star-btn")?.addEventListener("click", () => {
      const c = state.candidates.find(c => c.id === Number(card.dataset.id));
      if (c) { c.starred = !c.starred; renderAll(); scheduleSave(); }
    });
  });

  wrap.querySelectorAll(".kanban-col-body").forEach(col => {
    col.addEventListener("dragover", e => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", e => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const id = Number(e.dataTransfer.getData("text/plain"));
      const c = state.candidates.find(c => c.id === id);
      if (c) { c.status = col.dataset.status; renderAll(); scheduleSave(); }
    });
  });
}

function kanbanCard(c) {
  return `
    <div class="kanban-card" draggable="true" data-id="${c.id}">
      <div class="kanban-card-top">
        <span class="kanban-card-name">${escapeHtml(c.name || c.fileName)}</span>
        <button class="star-btn ${c.starred ? "on" : ""}" title="Star">${c.starred ? "★" : "☆"}</button>
      </div>
      <div class="kanban-card-meta">
        ${scorePill(c)}
        ${c.country ? `<span class="kanban-country">${escapeHtml(c.country)}</span>` : ""}
      </div>
      ${c.duplicate ? dupTag(c) : ""}
    </div>
  `;
}

// ---------- candidate drawer ----------
function openDrawer(id) {
  const c = state.candidates.find(c => c.id === id);
  if (!c) return;
  state.drawerId = id;
  el("drawerName").textContent = c.name || c.fileName || "Candidate";
  el("dName").value = c.name || "";
  el("dEmail").value = c.email || "";
  el("dPhone").value = c.phone || "";
  el("dLinkedin").value = c.linkedin || "";
  el("dCountry").value = c.country || "";
  el("dYears").value = c.yearsExp ?? "";
  el("dSource").value = c.source || "";
  el("dStatus").value = c.status || "New";
  el("dInterviewDate").value = c.interviewDate || "";
  el("dStar").textContent = c.starred ? "★ Starred" : "☆ Not starred";
  el("dStar").classList.toggle("on", Boolean(c.starred));
  el("dScore").textContent = (c.rating !== null && c.rating !== undefined) ? `${c.rating}/10 · ${c.score}% match` : "Not yet scored";

  renderQuickLinks(c);
  renderTagEditor(c);
  renderNotesLog(c);

  el("drawerOverlay").hidden = false;
}

function closeDrawer() {
  el("drawerOverlay").hidden = true;
  state.drawerId = null;
}
el("btnCloseDrawer").addEventListener("click", closeDrawer);
el("drawerOverlay").addEventListener("click", e => { if (e.target === el("drawerOverlay")) closeDrawer(); });

function currentDrawerCandidate() {
  return state.candidates.find(c => c.id === state.drawerId);
}

function renderQuickLinks(c) {
  const wrap = el("dQuickLinks");
  const links = [];
  if (c.email) links.push(`<a href="mailto:${encodeURIComponent(c.email)}" target="_blank" rel="noopener">✉ Email</a>`);
  if (c.phone) links.push(`<a href="https://wa.me/${c.phone.replace(/[^\d]/g, "")}" target="_blank" rel="noopener">💬 WhatsApp</a>`);
  if (c.linkedin) links.push(`<a href="${escapeAttr(c.linkedin)}" target="_blank" rel="noopener">in LinkedIn</a>`);
  wrap.innerHTML = links.length ? links.join("") : '<span class="dim">No contact links extracted yet.</span>';
}

function renderTagEditor(c) {
  const wrap = el("dTags");
  const tags = c.tags || [];
  wrap.innerHTML = tags.map((t, i) =>
    `<span class="chip chip-removable">${escapeHtml(t)}<button data-i="${i}" class="chip-x">×</button></span>`
  ).join("") || '<span class="dim">No tags yet — add some below.</span>';
  wrap.querySelectorAll(".chip-x").forEach(btn => {
    btn.addEventListener("click", () => {
      const cand = currentDrawerCandidate();
      if (!cand) return;
      cand.tags.splice(Number(btn.dataset.i), 1);
      renderTagEditor(cand);
      renderAll();
      scheduleSave();
    });
  });
}
el("dTagInput").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const val = e.target.value.trim();
  if (!val) return;
  const c = currentDrawerCandidate();
  if (!c) return;
  c.tags = c.tags || [];
  if (!c.tags.some(t => t.toLowerCase() === val.toLowerCase())) c.tags.push(val);
  e.target.value = "";
  renderTagEditor(c);
  renderAll();
  scheduleSave();
});

function renderNotesLog(c) {
  const wrap = el("dNotesLog");
  const log = c.notesLog || [];
  wrap.innerHTML = log.length
    ? log.slice().reverse().map(n => `<div class="note-entry"><span class="note-ts">${escapeHtml(n.ts)}</span>${escapeHtml(n.text)}</div>`).join("")
    : '<p class="dim">No notes yet.</p>';
}
el("btnAddNote").addEventListener("click", () => {
  const c = currentDrawerCandidate();
  if (!c) return;
  const text = el("dNoteInput").value.trim();
  if (!text) return;
  c.notesLog = c.notesLog || [];
  c.notesLog.push({ ts: new Date().toLocaleString(), text });
  el("dNoteInput").value = "";
  renderNotesLog(c);
  scheduleSave();
});

// Save drawer field edits back onto the candidate as the user types/changes them.
["dName", "dEmail", "dPhone", "dLinkedin", "dCountry", "dYears", "dSource", "dStatus", "dInterviewDate"].forEach(id => {
  el(id).addEventListener("change", () => {
    const c = currentDrawerCandidate();
    if (!c) return;
    const map = {
      dName: "name", dEmail: "email", dPhone: "phone", dLinkedin: "linkedin",
      dCountry: "country", dYears: "yearsExp", dSource: "source", dStatus: "status",
      dInterviewDate: "interviewDate",
    };
    const field = map[id];
    let val = el(id).value;
    if (field === "yearsExp") val = val === "" ? null : Number(val);
    c[field] = val;
    if (field === "email" || field === "phone") flagDuplicates();
    el("drawerName").textContent = c.name || c.fileName || "Candidate";
    renderAll();
    scheduleSave();
  });
});

el("dStar").addEventListener("click", () => {
  const c = currentDrawerCandidate();
  if (!c) return;
  c.starred = !c.starred;
  el("dStar").textContent = c.starred ? "★ Starred" : "☆ Not starred";
  el("dStar").classList.toggle("on", c.starred);
  renderAll();
  scheduleSave();
});

el("btnPreviewFile").addEventListener("click", () => {
  const c = currentDrawerCandidate();
  if (!c) return;
  if (!c.file) { toast("Original file isn't available — it was cleared on refresh. Re-drop the CV to restore it."); return; }
  const url = URL.createObjectURL(c.file);
  window.open(url, "_blank", "noopener");
});

el("btnDeleteCandidate").addEventListener("click", () => {
  const c = currentDrawerCandidate();
  if (!c) return;
  if (confirm(`Remove ${c.name || c.fileName} from the manifest?`)) {
    removeCandidate(c.id, false);
    closeDrawer();
  }
});

// ---------- filters / view controls ----------
["searchInput", "statusFilter", "sortSelect"].forEach(id =>
  el(id).addEventListener("input", renderAll)
);
el("statusFilter").addEventListener("change", renderAll);
el("sortSelect").addEventListener("change", renderAll);

function updateFootStats() {
  const dupCount = state.candidates.filter(c => c.duplicate).length;
  el("footStats").textContent =
    `${state.candidates.length} candidate${state.candidates.length === 1 ? "" : "s"} · ${dupCount} duplicate${dupCount === 1 ? "" : "s"} flagged`;
}

// ---------- exports ----------
function flattenNotes(c) {
  return (c.notesLog || []).map(n => `[${n.ts}] ${n.text}`).join(" | ");
}

function exportRows() {
  return getFilteredSorted().map(c => ({
    "Full name": c.name,
    "Email": c.email,
    "WhatsApp number": c.phone,
    "LinkedIn": c.linkedin || "",
    "Country": c.country,
    "Years exp": c.yearsExp ?? "",
    "Tags": (c.tags || []).join("; "),
    "Rating (1-10)": c.rating ?? "",
    "Match %": c.score ?? "",
    "Status": c.status,
    "Source": c.source || "",
    "Interview date": c.interviewDate || "",
    "Starred": c.starred ? "Yes" : "",
    "Notes": flattenNotes(c),
    "Source file": c.fileName,
  }));
}

el("btnCopy").addEventListener("click", () => {
  const rows = exportRows();
  if (!rows.length) { toast("Nothing to copy yet"); return; }
  const headers = Object.keys(rows[0]);
  const tsv = [headers.join("\t"), ...rows.map(r => headers.map(h => (r[h] ?? "").toString().replace(/\t|\n/g, " ")).join("\t"))].join("\n");
  navigator.clipboard.writeText(tsv).then(
    () => toast("Copied — paste straight into Google Sheets or Excel"),
    () => toast("Couldn't copy — your browser blocked clipboard access")
  );
});

el("btnCSV").addEventListener("click", () => {
  const rows = exportRows();
  if (!rows.length) { toast("Nothing to export yet"); return; }
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(","))].join("\n");
  downloadBlob(csv, "candidates.csv", "text/csv");
});

function csvEscape(v) {
  const s = (v ?? "").toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

el("btnXLSX").addEventListener("click", () => {
  const rows = exportRows();
  if (!rows.length) { toast("Nothing to export yet"); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Candidates");
  XLSX.writeFile(wb, "candidates.xlsx");
});

el("btnZip").addEventListener("click", async () => {
  const rows = getFilteredSorted();
  if (!rows.length) { toast("Nothing to zip yet"); return; }
  const withFiles = rows.filter(c => c.file);
  const missing = rows.length - withFiles.length;
  if (!withFiles.length) { toast("None of these candidates have their original file in this session — re-drop the CVs to zip them."); return; }
  const zip = new JSZip();
  withFiles.forEach(c => {
    const ext = c.fileName.split(".").pop();
    const safe = (c.name || c.fileName).replace(/[\\/:*?"<>|]/g, "").trim() || c.fileName;
    zip.file(`${safe}.${ext}`, c.file);
  });
  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "cvs-renamed.zip";
  a.click();
  if (missing > 0) toast(`Zipped ${withFiles.length} — skipped ${missing} without an in-session file`);
});

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ---------- settings / Google Sheet connection ----------
const SETTINGS_KEY = "cv-sorter-webapp-url";
const SECRET_KEY = "cv-sorter-api-secret";

function getSavedUrl() {
  return localStorage.getItem(SETTINGS_KEY) || "";
}
function getSavedSecret() {
  return localStorage.getItem(SECRET_KEY) || "";
}
function refreshSheetStatus() {
  const url = getSavedUrl();
  const badge = el("sheetStatus");
  if (url) {
    badge.textContent = "Sheet connected";
    badge.classList.add("connected");
  } else {
    badge.textContent = "Sheet not connected";
    badge.classList.remove("connected");
  }
}
refreshSheetStatus();

el("btnSettings").addEventListener("click", () => {
  el("webAppUrl").value = getSavedUrl();
  el("apiSecret").value = getSavedSecret();
  el("settingsStatus").textContent = "";
  el("settingsModal").hidden = false;
});
el("btnCloseSettings").addEventListener("click", () => (el("settingsModal").hidden = true));
el("settingsModal").addEventListener("click", e => {
  if (e.target === el("settingsModal")) el("settingsModal").hidden = true;
});

el("btnSaveSettings").addEventListener("click", () => {
  const url = el("webAppUrl").value.trim();
  const secret = el("apiSecret").value.trim();
  localStorage.setItem(SETTINGS_KEY, url);
  localStorage.setItem(SECRET_KEY, secret);
  refreshSheetStatus();
  el("settingsStatus").textContent = url ? "Saved." : "Cleared — no sheet connected.";
  el("settingsStatus").className = "settings-status ok";
});

el("btnTestSettings").addEventListener("click", async () => {
  const url = el("webAppUrl").value.trim();
  if (!url) { setSettingsErr("Paste your Web App URL first."); return; }
  el("settingsStatus").textContent = "Testing…";
  el("settingsStatus").className = "settings-status";
  try {
    const res = await sheetRequest(url, { action: "ping", secret: el("apiSecret").value.trim() });
    if (res && res.ok) {
      el("settingsStatus").textContent = "Connected — sheet says hello.";
      el("settingsStatus").className = "settings-status ok";
    } else {
      setSettingsErr("Reached the script, but it didn't confirm. Check the Apps Script code matches apps-script.gs.");
    }
  } catch (err) {
    setSettingsErr("Couldn't reach that URL. Re-check the deployment (see README).");
  }
});
function setSettingsErr(msg) {
  el("settingsStatus").textContent = msg;
  el("settingsStatus").className = "settings-status err";
}

el("btnClearAll").addEventListener("click", () => {
  if (!confirm("Remove every candidate from this browser's saved manifest? This can't be undone. Rows already pushed to your Google Sheet are not affected.")) return;
  state.candidates = [];
  state.selected.clear();
  localStorage.removeItem(AUTOSAVE_KEY);
  renderAll();
  toast("Manifest cleared from this browser");
});

async function sheetRequest(url, payload) {
  // Apps Script web apps don't support CORS preflight, so we send
  // text/plain and parse JSON on the server side of apps-script.gs.
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

el("btnPushSheet").addEventListener("click", async () => {
  const url = getSavedUrl();
  if (!url) { el("btnSettings").click(); return; }
  const rows = state.candidates.filter(c => !c.pushed);
  if (!rows.length) { setPushStatus("Nothing new to push — everything's already in the sheet.", true); return; }

  setPushStatus(`Pushing ${rows.length} row${rows.length === 1 ? "" : "s"}…`, true);
  try {
    const payload = {
      action: "append",
      secret: getSavedSecret(),
      rows: rows.map(c => ({
        name: c.name, email: c.email, phone: c.phone, linkedin: c.linkedin || "",
        country: c.country, yearsExp: c.yearsExp ?? "", tags: (c.tags || []).join("; "),
        score: c.score ?? "", rating: c.rating ?? "", status: c.status,
        source: c.source || "", interviewDate: c.interviewDate || "",
        starred: c.starred ? "Yes" : "", notes: flattenNotes(c), fileName: c.fileName,
      })),
    };
    const res = await sheetRequest(url, payload);
    if (res && res.ok) {
      rows.forEach(c => (c.pushed = true));
      scheduleSave();
      setPushStatus(`Pushed ${rows.length} row${rows.length === 1 ? "" : "s"} to the sheet.`, true);
    } else if (res && res.error === "Unauthorized") {
      setPushStatus("Sheet rejected the request — the API secret in Settings doesn't match apps-script.gs.", false);
    } else {
      setPushStatus("Sheet didn't confirm the write — check the Apps Script deployment.", false);
    }
  } catch (err) {
    setPushStatus("Couldn't reach the sheet. Check the connection in Settings.", false);
  }
});
function setPushStatus(msg, ok) {
  const p = el("pushStatus");
  p.textContent = msg;
  p.className = "push-status " + (ok ? "ok" : "err");
}

// ---------- utils ----------
function escapeHtml(str) {
  return (str ?? "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

// ---------- boot ----------
restoreState();
flagDuplicates();
renderAll();

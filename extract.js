/* extract.js — turns a CV file into plain text, then plain text into
   candidate fields. Heuristic, not perfect — the manifest table (and
   candidate drawer) are always editable so anything mis-read is a
   two-second fix. */

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// ---------- section-heading vocabulary ----------
// Used to (a) recognize where a "skills" or "experience" block starts and
// ends, and (b) reject document-title / other-section lines from being
// mistaken for a candidate's name. Kept broad on purpose — CV templates use
// a lot of different phrasing for the same section.
const SKILLS_HEADER_ALIASES = [
  "skills", "core skills", "key skills", "technical skills", "core competencies",
  "key competencies", "competencies", "areas of expertise", "technical proficiencies",
  "computer skills", "soft skills", "skills & competencies", "skills and competencies",
  "key skills and competencies", "skills summary", "professional skills",
];
const EXPERIENCE_HEADER_ALIASES = [
  "experience", "work experience", "professional experience", "employment history",
  "work history", "career history", "relevant experience", "professional background",
];
const OTHER_SECTION_HEADERS = [
  "curriculum vitae", "résumé", "resume", "personal information", "personal details",
  "contact information", "contact details", "contact", "profile", "professional profile",
  "professional summary", "career summary", "personal profile", "summary", "objective",
  "career objective", "address", "email", "phone", "mobile", "whatsapp",
  "date of birth", "nationality", "gender", "marital status", "references", "reference",
  "education", "certifications", "certifications & licenses", "languages", "languages spoken",
  "projects", "awards", "achievements", "achievements & awards", "hobbies", "interests",
  "declaration", "publications", "volunteer experience", "summary of coursework", "courses",
  "employment history", "cv", "c.v.",
];
// Every section heading we recognize, used to find where a block ENDS.
const ALL_SECTION_HEADERS = new Set(
  [...SKILLS_HEADER_ALIASES, ...EXPERIENCE_HEADER_ALIASES, ...OTHER_SECTION_HEADERS]
);
// Kept for backwards compatibility with the rest of this file.
const HEADER_WORDS = OTHER_SECTION_HEADERS;

// Single tokens that, if present anywhere in a candidate "name" line, mean
// it's a document title ("Curriculum Vitae — Jane Doe"), not a name.
const TITLE_KEYWORDS = new Set(["curriculum", "vitae", "resume", "résumé", "cv", "c.v", "biodata"]);

async function fileToText(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") return pdfToText(file);
  if (ext === "docx") return docxToText(file);
  throw new Error("Unsupported file type: ." + ext);
}

async function pdfToText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  let page1Linear = "";
  const pages = Math.min(pdf.numPages, 6); // CV contact info is always up front
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    // disableCombineTextItems gives us raw, ungrouped glyph runs with exact
    // positions instead of trusting pdf.js's own (sometimes wrong) word
    // grouping — some CV templates use letter-spacing/kerning that makes
    // pdf.js's default combining split single words apart (e.g. "TADZIE"
    // becoming "TADZ" + "IE"). We do our own grouping below using geometry.
    const content = await page.getTextContent({ disableCombineTextItems: true });
    const runs = pageRuns(content.items);
    text += pageItemsToText(content.items, viewport.width) + "\n";
    if (i === 1) {
      // A candidate's name is always near the very top of page 1. If this
      // page gets column-split (e.g. a sidebar CV template), the name can
      // end up pushed well past the top-20-lines window used for name
      // detection once one whole column's text is read before the other.
      // Keep an always-linear (never column-split) version of page 1 just
      // for that purpose — reading order everywhere else stays column-aware.
      page1Linear = joinRunsToLines(runs);
    }
  }
  return { text, headerText: page1Linear || text };
}

function pageRuns(items) {
  return items
    .filter(it => typeof it.str === "string" && it.str.length)
    .map(it => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      width: it.width || 0,
      height: Math.abs(it.transform[3]) || it.height || 10,
    }));
}

function pageItemsToText(items, pageWidth) {
  const runs = pageRuns(items);
  if (!runs.length) return "";

  // Some CV templates use a genuine two-column layout (e.g. a narrow
  // "Contact / Skills" sidebar next to a main column). Reading such a page
  // in raw top-to-bottom order zippers the two columns' lines together,
  // scrambling both. Detect that pattern and read each side independently;
  // otherwise fall back to a normal single reading order.
  const split = detectColumnSplit(runs, pageWidth);
  if (!split) {
    return joinRunsToLines(runs);
  }
  return joinRunsToLines(split.leftRuns) + "\n" + joinRunsToLines(split.rightRuns);
}

function groupIntoRows(runs) {
  const sorted = runs.slice().sort((a, b) => b.y - a.y);
  const rows = [];
  for (const r of sorted) {
    const row = rows.find(row => Math.abs(row.y - r.y) <= 2);
    if (row) row.runs.push(r);
    else rows.push({ y: r.y, runs: [r] });
  }
  for (const row of rows) row.startX = Math.min(...row.runs.map(r => r.x));
  return rows;
}

function detectColumnSplit(runs, pageWidth) {
  if (!pageWidth) return null;
  const rows = groupIntoRows(runs);
  if (rows.length < 8) return null;

  // Find the widest gap in where each ROW starts (not each individual text
  // run — a centered section heading like "EDUCATION" above left-aligned
  // body text also produces a bimodal x-split, but per-row is what tells
  // a real column apart from an occasional centered heading, below).
  const xs = rows.map(r => r.startX).sort((a, b) => a - b);
  let bestGap = 0, bestSplit = null;
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];
    if (gap > bestGap) { bestGap = gap; bestSplit = (xs[i] + xs[i - 1]) / 2; }
  }
  if (bestGap < pageWidth * 0.12) return null;
  if (bestSplit < pageWidth * 0.2 || bestSplit > pageWidth * 0.8) return null;

  const side = rows.map(r => (r.startX < bestSplit ? "L" : "R"));
  const leftCount = side.filter(s => s === "L").length;
  const rightCount = side.filter(s => s === "R").length;
  const minShare = Math.max(3, rows.length * 0.15);
  if (leftCount < minShare || rightCount < minShare) return null;

  // Genuine two-column templates interleave on nearly every consecutive
  // row (a sidebar runs in parallel with the main column for the whole
  // page). A centered heading or a right-aligned date column instead shows
  // up as rare, isolated spikes — reject those by requiring the minority
  // side to never go too many rows without reappearing.
  const minoritySide = leftCount <= rightCount ? "L" : "R";
  let maxGap = 0, sinceLast = 0;
  for (const s of side) {
    if (s === minoritySide) { maxGap = Math.max(maxGap, sinceLast); sinceLast = 0; }
    else sinceLast++;
  }
  maxGap = Math.max(maxGap, sinceLast);
  if (maxGap > 3) return null;

  const leftRows = rows.filter(r => r.startX < bestSplit);
  const rightRows = rows.filter(r => r.startX >= bestSplit);
  const ySpan = arr => { const ys = arr.map(r => r.y); return Math.max(...ys) - Math.min(...ys); };
  const totalSpan = ySpan(rows);
  if (totalSpan <= 0) return null;
  if (ySpan(leftRows) < totalSpan * 0.3 || ySpan(rightRows) < totalSpan * 0.3) return null;

  return {
    leftRuns: leftRows.flatMap(r => r.runs),
    rightRuns: rightRows.flatMap(r => r.runs),
  };
}

function joinRunsToLines(runs) {
  const sorted = runs.slice().sort((a, b) => {
    if (Math.abs(a.y - b.y) > 2) return b.y - a.y; // PDF y grows upward
    return a.x - b.x;
  });
  let text = "";
  let lastY = null;
  let lastEndX = null;
  let line = "";
  for (const r of sorted) {
    const newLine = lastY !== null && Math.abs(r.y - lastY) > 2;
    if (newLine) {
      text += line.trim() + "\n";
      line = "";
      lastEndX = null;
    }
    if (lastEndX !== null && !newLine) {
      const gap = r.x - lastEndX;
      // Only insert a space if there's a real visual gap AND the text
      // doesn't already end in whitespace — avoids both mid-word splits
      // ("Tadz" + "Ie") and doubled-up spaces from runs that already
      // include their own trailing space.
      const needsSpace = gap > r.height * 0.2;
      if (needsSpace && !/\s$/.test(line)) line += " ";
    }
    line += r.str;
    lastEndX = r.x + r.width;
    lastY = r.y;
  }
  text += line.trim() + "\n";
  return text;
}

async function docxToText(file) {
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return { text: result.value, headerText: result.value };
}

function extractEmail(text) {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if (!matches) return "";
  // Prefer one that isn't obviously a placeholder/template address.
  const clean = matches.find(m => !/example\.com|domain\.com|yourname/i.test(m));
  return clean || matches[0];
}

function extractPhone(text) {
  const labelRe = /(whats\s?app|mobile|phone|tel(?:ephone)?|cell|contact)\s*(?:no\.?|number)?\s*[:\-]?\s*(\+?[\d][\d\s\-().]{6,20}\d)/gi;
  const candidates = [];
  let m;
  while ((m = labelRe.exec(text)) !== null) {
    candidates.push({ raw: m[2], labeled: /whats\s?app/i.test(m[1]) ? 2 : 1 });
  }
  const anyRe = /(\+\d{1,3}[\s\-]?)?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,4}(?:[\s\-]?\d{2,4})?/g;
  while ((m = anyRe.exec(text)) !== null) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) {
      candidates.push({ raw: m[0], labeled: 0 });
    }
  }
  if (!candidates.length) return "";

  // Prefer WhatsApp-labeled, then any labeled, then plain — and prefer ones with a leading +.
  candidates.sort((a, b) => {
    if (b.labeled !== a.labeled) return b.labeled - a.labeled;
    const aPlus = a.raw.trim().startsWith("+") ? 1 : 0;
    const bPlus = b.raw.trim().startsWith("+") ? 1 : 0;
    return bPlus - aPlus;
  });

  return formatPhone(candidates[0].raw);
}

function formatPhone(raw) {
  let digits = raw.replace(/[^\d+]/g, "");
  if (!digits.startsWith("+")) {
    // No leading + found in text — try to infer from a matched dial code
    // only when the number is long enough to plausibly include one;
    // otherwise leave as-is for the user to correct.
    if (digits.length > 10) digits = "+" + digits;
  }
  return digits;
}

function extractCountry(text, phone) {
  // 1) Look for an explicit country name near address/nationality/location cues.
  const lower = text.toLowerCase();
  for (const name of COUNTRY_NAMES) {
    const re = new RegExp("\\b" + name.replace(/[().]/g, "\\$&") + "\\b", "i");
    if (re.test(text)) {
      return name === "USA" || name === "United States of America" ? "United States" : name;
    }
  }
  // 2) Fall back to the phone's dial code.
  if (phone && phone.startsWith("+")) {
    const digits = phone.slice(1);
    for (const [code, country] of DIAL_CODES) {
      if (digits.startsWith(code)) return country;
    }
  }
  return "";
}

function looksLikeName(line) {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 45) return false;
  if (/\d/.test(trimmed)) return false;
  if (/@/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase().replace(/:$/, "");
  if (ALL_SECTION_HEADERS.has(lower)) return false;
  // Reject lines that START with a recognized section heading even when
  // followed by more text on the same line — e.g. a CV that literally
  // prints "PERSONAL INFORMATION COMFORT SACKITEY" as one line.
  for (const h of ALL_SECTION_HEADERS) {
    if (lower.startsWith(h + " ") || lower.startsWith(h + ":")) return false;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  // Reject document-title lines like "Curriculum Vitae" or "Curriculum
  // Vitae — Jane Doe" even when mixed with real name words on the same line.
  if (words.some(w => TITLE_KEYWORDS.has(w.toLowerCase().replace(/[.,]/g, "")))) return false;
  // Each word should look like a name token (allow hyphens/apostrophes, all-caps or capitalized).
  const nameWordRe = /^[A-Z][a-zA-Z'\-.]*$/;
  const allCapsWordRe = /^[A-Z'\-]{2,}$/;
  return words.every(w => nameWordRe.test(w) || allCapsWordRe.test(w));
}

// Explicit "Name: John Doe" / "Full Name: [John Doe]" labels — common in
// more formally-structured CVs, and not caught by the generic heuristic
// below since a leading "NAME:" token doesn't itself look name-shaped.
function extractLabeledName(lines) {
  for (const line of lines) {
    const m = line.match(/^(?:full\s*name|name)\s*[:\-]\s*(.+)$/i);
    if (!m) continue;
    let val = m[1].trim().replace(/^\[+|\]+$/g, "").trim();
    if (!val || /\d/.test(val) || /@/.test(val)) continue;
    const words = val.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 5) continue;
    return toTitleCase(val);
  }
  return null;
}

// When a line is a section heading with a name stapled onto the end of it
// ("PERSONAL INFORMATION COMFORT SACKITEY"), the whole line correctly fails
// looksLikeName — but the trailing remainder after the heading is often the
// actual name. Returns that remainder, or null if the line doesn't start
// with a recognized heading.
function stripLeadingHeaderPhrase(line) {
  const lower = line.trim().toLowerCase();
  for (const h of ALL_SECTION_HEADERS) {
    if (lower.startsWith(h + " ") || lower.startsWith(h + ":")) {
      return line.trim().slice(h.length).replace(/^[:\s]+/, "").trim();
    }
  }
  return null;
}

function extractName(headerText, fileName) {
  const lines = headerText.split("\n").map(l => l.trim()).filter(Boolean).slice(0, 20);
  const labeled = extractLabeledName(lines);
  if (labeled) return labeled;
  for (const line of lines) {
    if (looksLikeName(line)) {
      return toTitleCase(line);
    }
    const remainder = stripLeadingHeaderPhrase(line);
    if (remainder && looksLikeName(remainder)) {
      return toTitleCase(remainder);
    }
  }
  // Fallback: derive from filename ("John_Doe_CV.pdf" -> "John Doe")
  let base = fileName.replace(/\.[^.]+$/, "");
  base = base.replace(/[_\-]+/g, " ");
  base = base.replace(/\b(cv|resume|résumé|final|updated|new|copy|version\s?\d*)\b/gi, "");
  base = base.replace(/\s+/g, " ").trim();
  // A purely numeric filename (e.g. a system-generated upload ID like
  // "1786632749584") isn't a name — showing it as one is more misleading
  // than leaving the field blank for the user to fill in.
  if (!base || !/[a-zA-Z]/.test(base)) return "";
  return toTitleCase(base);
}

function toTitleCase(str) {
  return str
    .toLowerCase()
    .split(" ")
    .map(w => w ? w[0].toUpperCase() + w.slice(1) : w)
    .join(" ")
    .trim();
}

// ---------- LinkedIn ----------
function extractLinkedIn(text) {
  const m = text.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[a-zA-Z0-9\-_%]+\/?/i);
  if (!m) return "";
  let url = m[0];
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url.replace(/\/$/, "");
}

// ---------- shared helper: pull the lines belonging to one CV section ----------
// Finds a header line matching one of `headerAliases`, then returns the
// lines up to (but not including) the next recognized section heading —
// or up to `maxLines` lines, whichever comes first. Returns null if no
// matching header is found at all.
function findSectionLines(lines, headerAliases, maxLines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase().replace(/:$/, "").trim();
    if (headerAliases.includes(lower)) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const lower = (lines[i] || "").toLowerCase().replace(/:$/, "").trim();
    if (lower && ALL_SECTION_HEADERS.has(lower)) { end = i; break; }
  }
  if (maxLines) end = Math.min(end, start + maxLines);
  return lines.slice(start, end);
}

// ---------- years of experience ----------
function extractYearsExperience(text) {
  // Look for explicit "N years / N+ years [of] experience" mentions first —
  // usually a summary line and the most reliable signal.
  const explicit = text.match(/(\d{1,2})\+?\s*(?:years?|yrs?)\s*(?:of\s*)?(?:relevant\s*|professional\s*|work(?:ing)?\s*)?experience/gi);
  if (explicit && explicit.length) {
    const nums = explicit.map(s => parseInt(s.match(/\d{1,2}/)[0], 10)).filter(n => n > 0 && n <= 50);
    if (nums.length) return Math.max(...nums);
  }
  // Fallback: infer from date ranges (e.g. 2018 - 2023, 2019 - Present) —
  // but ONLY within a recognizable work-experience section. Scanning the
  // whole document also picks up Education dates (degree years, school
  // years), which badly overstates tenure for junior candidates.
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const sectionLines = findSectionLines(lines, EXPERIENCE_HEADER_ALIASES, 60);
  if (!sectionLines) return null;
  const scanText = sectionLines.join("\n");
  const yearMatches = [...scanText.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b\s*[-–—to]{1,4}\s*(present|current|now|\b(19[5-9]\d|20[0-4]\d)\b)/gi)];
  if (yearMatches.length) {
    const currentYear = new Date().getFullYear();
    let earliest = currentYear;
    yearMatches.forEach(m => {
      const start = parseInt(m[1], 10);
      if (start < earliest) earliest = start;
    });
    const span = currentYear - earliest;
    if (span > 0 && span <= 50) return span;
  }
  return null;
}

// ---------- tags / skills ----------
function looksLikeSkillPhrase(s) {
  if (/@/.test(s)) return false; // stray email fragment
  if (/\d{3}[\s\-]?\d{3,4}[\s\-]?\d{3,4}/.test(s)) return false; // stray phone fragment
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false; // reads like a sentence, not a skill tag
  if (/[.!?]$/.test(s.trim())) return false; // ends like a sentence
  if (/^(and|with|the|in|of|for|to|on|a|an)\b/i.test(s.trim())) return false; // sentence fragment, not a tag
  return true;
}

function extractTags(text) {
  const lines = text.split("\n").map(l => l.trim());
  const block = findSectionLines(lines, SKILLS_HEADER_ALIASES, 12);
  if (!block) return [];
  const joined = block.join(", ");
  const raw = joined.split(/[,•|;\u2022\n]/).map(s => s.trim()).filter(Boolean);
  const tags = [];
  const seen = new Set();
  for (const r of raw) {
    const clean = r.replace(/^[-–—•●▪‣*]\s*/, "").trim();
    if (!clean || clean.length < 2 || clean.length > 30) continue;
    if (!looksLikeSkillPhrase(clean)) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(clean);
    if (tags.length >= 15) break;
  }
  return tags;
}

function extractFields(text, fileName, headerText) {
  const email = extractEmail(text);
  const phone = extractPhone(text);
  const country = extractCountry(text, phone);
  const name = extractName(headerText || text, fileName);
  const linkedin = extractLinkedIn(text);
  const yearsExp = extractYearsExperience(text);
  const tags = extractTags(text);
  // If almost nothing came out of the file, this is very likely a
  // scanned/image-only PDF (no real text layer) rather than an extraction
  // bug — flag it instead of silently leaving every field blank.
  if (text.replace(/\s/g, "").length < 40) {
    tags.push("⚠ couldn't read text (scanned/image PDF?)");
  }
  return { name, email, phone, country, linkedin, yearsExp, tags };
}

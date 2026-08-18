/* extract.js — turns a CV file into plain text, then plain text into
   candidate fields. Heuristic, not perfect — the manifest table (and
   candidate drawer) are always editable so anything mis-read is a
   two-second fix. */

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const HEADER_WORDS = [
  "curriculum vitae","résumé","resume","personal information","personal details",
  "contact information","contact details","profile","professional profile","summary",
  "objective","career objective","address","email","phone","mobile","whatsapp",
  "date of birth","nationality","gender","marital status","references","reference",
  "education","experience","work experience","skills","certifications","languages",
  "employment history","cv","c.v."
];

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
  const pages = Math.min(pdf.numPages, 6); // CV contact info is always up front
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Keep rough line breaks by watching for vertical position jumps.
    let lastY = null;
    let line = "";
    for (const item of content.items) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        text += line.trim() + "\n";
        line = "";
      }
      line += item.str + " ";
      lastY = y;
    }
    text += line.trim() + "\n";
  }
  return text;
}

async function docxToText(file) {
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return result.value;
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
  const lower = trimmed.toLowerCase();
  if (HEADER_WORDS.some(w => lower === w || lower.startsWith(w + ":"))) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  // Each word should look like a name token (allow hyphens/apostrophes, all-caps or capitalized).
  const nameWordRe = /^[A-Z][a-zA-Z'\-.]*$/;
  const allCapsWordRe = /^[A-Z'\-]{2,}$/;
  return words.every(w => nameWordRe.test(w) || allCapsWordRe.test(w));
}

function extractName(text, fileName) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean).slice(0, 20);
  for (const line of lines) {
    if (looksLikeName(line)) {
      return toTitleCase(line);
    }
  }
  // Fallback: derive from filename ("John_Doe_CV.pdf" -> "John Doe")
  let base = fileName.replace(/\.[^.]+$/, "");
  base = base.replace(/[_\-]+/g, " ");
  base = base.replace(/\b(cv|resume|résumé|final|updated|new|copy|version\s?\d*)\b/gi, "");
  base = base.replace(/\s+/g, " ").trim();
  return base ? toTitleCase(base) : "";
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

// ---------- years of experience ----------
function extractYearsExperience(text) {
  // Look for explicit "N years / N+ years [of] experience" mentions first —
  // usually a summary line and the most reliable signal.
  const explicit = text.match(/(\d{1,2})\+?\s*(?:years?|yrs?)\s*(?:of\s*)?(?:relevant\s*|professional\s*|work(?:ing)?\s*)?experience/gi);
  if (explicit && explicit.length) {
    const nums = explicit.map(s => parseInt(s.match(/\d{1,2}/)[0], 10)).filter(n => n > 0 && n <= 50);
    if (nums.length) return Math.max(...nums);
  }
  // Fallback: infer from an "Experience" section's date ranges (e.g. 2018 - 2023, 2019 - Present).
  const yearMatches = [...text.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b\s*[-–—to]{1,4}\s*(present|current|now|\b(19[5-9]\d|20[0-4]\d)\b)/gi)];
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
function extractTags(text) {
  const lines = text.split("\n").map(l => l.trim());
  const isHeader = (l) => {
    const lower = l.toLowerCase().replace(/:$/, "");
    return HEADER_WORDS.some(w => lower === w);
  };
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase().replace(/:$/, "");
    if (lower === "skills" || lower === "core skills" || lower === "key skills" || lower === "technical skills") {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i] && isHeader(lines[i]) && lines[i].toLowerCase() !== "skills") { end = i; break; }
  }
  const block = lines.slice(start, Math.min(end, start + 12)).join(", ");
  const raw = block.split(/[,•|;\u2022\n]/).map(s => s.trim()).filter(Boolean);
  const tags = [];
  const seen = new Set();
  for (const r of raw) {
    const clean = r.replace(/^[-–—•*]\s*/, "").trim();
    if (!clean || clean.length < 2 || clean.length > 30) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(clean);
    if (tags.length >= 15) break;
  }
  return tags;
}

function extractFields(text, fileName) {
  const email = extractEmail(text);
  const phone = extractPhone(text);
  const country = extractCountry(text, phone);
  const name = extractName(text, fileName);
  const linkedin = extractLinkedIn(text);
  const yearsExp = extractYearsExperience(text);
  const tags = extractTags(text);
  return { name, email, phone, country, linkedin, yearsExp, tags };
}

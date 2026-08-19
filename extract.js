/* extract.js — turns a CV file into plain text, then plain text into
   candidate fields. Heuristic, not perfect — the manifest table is
   always editable so anything mis-read is a two-second fix. */

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const HEADER_WORDS = [
  "curriculum vitae","résumé","resume","personal information","personal details",
  "contact information","contact details","profile","professional profile","summary",
  "professional summary","career summary","executive summary",
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
  // "(0)" is a trunk-prefix marker (e.g. "+233 (0) 20 324 3492" meaning
  // "drop the 0 when dialing internationally") — strip it before matching,
  // otherwise it breaks the regex and silently drops the country code.
  const cleanedText = text.replace(/\(\s*0\s*\)/g, " ");

  const labelRe = /(whats\s?app|mobile|phone|tel(?:ephone)?|cell|contact)\s*(?:no\.?|number)?\s*[:\-]?\s*\[?(\+?[\d][\d\s\-().]{6,20}\d)\]?/gi;
  const candidates = [];
  let m;
  while ((m = labelRe.exec(cleanedText)) !== null) {
    const start = m.index + m[0].indexOf(m[2]);
    candidates.push({ raw: m[2], labeled: /whats\s?app/i.test(m[1]) ? 2 : 1, start, end: start + m[2].length });
  }
  const anyRe = /(\+\d{1,3}[\s\-]?)?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,4}(?:[\s\-]?\d{2,4})?/g;
  while ((m = anyRe.exec(cleanedText)) !== null) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) {
      candidates.push({ raw: m[0], labeled: 0, start: m.index, end: m.index + m[0].length });
    }
  }
  // A second pass for unbroken digit runs catches numbers the chunked
  // pattern above sometimes truncates by a digit.
  const runRe = /\d{9,15}/g;
  while ((m = runRe.exec(cleanedText)) !== null) {
    candidates.push({ raw: m[0], labeled: 0, start: m.index, end: m.index + m[0].length });
  }
  if (!candidates.length) return "";

  // Different regexes can each capture only *part* of the same real number
  // (e.g. the chunked pattern grabs "233 54038038" while the digit-run
  // pattern separately grabs "540380387" one character over) — so instead
  // of picking whichever single match "wins", merge any candidates whose
  // text spans overlap into one group and re-read the *full* span from the
  // document. That guarantees the merged result isn't missing a digit
  // either match cut off on its own. Candidates that don't overlap are
  // genuinely different numbers and are kept separate.
  candidates.sort((a, b) => a.start - b.start);
  const groups = [];
  candidates.forEach(c => {
    const last = groups[groups.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      last.labeled = Math.max(last.labeled, c.labeled);
    } else {
      groups.push({ start: c.start, end: c.end, labeled: c.labeled });
    }
  });
  groups.forEach(g => (g.raw = cleanedText.slice(g.start, g.end)));

  // Prefer WhatsApp-labeled, then any labeled, then a leading +; ties keep
  // first-occurrence order, since the first-listed number on a CV is
  // almost always the candidate's own primary contact rather than a
  // reference's number further down the page.
  groups.sort((a, b) => {
    if (b.labeled !== a.labeled) return b.labeled - a.labeled;
    const aPlus = a.raw.trim().startsWith("+") ? 1 : 0;
    const bPlus = b.raw.trim().startsWith("+") ? 1 : 0;
    if (bPlus !== aPlus) return bPlus - aPlus;
    return a.start - b.start;
  });

  return formatPhone(groups[0].raw);
}

function formatPhone(raw) {
  // Just clean the characters here — country-code normalization happens
  // separately in normalizePhoneWithCountry, once we know the country.
  return raw.replace(/\(\s*0\s*\)/g, "").replace(/[^\d+]/g, "");
}

// Reverse lookup built from DIAL_CODES — first dial code listed per country wins.
const COUNTRY_TO_DIAL = {};
DIAL_CODES.forEach(([code, country]) => {
  if (!(country in COUNTRY_TO_DIAL)) COUNTRY_TO_DIAL[country] = code;
});

function normalizePhoneWithCountry(phone, country) {
  if (!phone) return phone;
  if (phone.startsWith("+")) return phone; // already has a country code
  const dial = COUNTRY_TO_DIAL[country];
  if (!dial) return phone; // don't guess if we don't know the country
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith(dial)) {
    // Number already includes the dial code, just missing the "+" — don't double it up.
    return "+" + digits;
  }
  digits = digits.replace(/^0+/, ""); // drop local trunk zero(s)
  return "+" + dial + digits;
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
  // 3) Last resort: a recognizable major city in the address.
  for (const city in CITY_TO_COUNTRY) {
    if (new RegExp("\\b" + city + "\\b", "i").test(lower)) return CITY_TO_COUNTRY[city];
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
  // An explicit "Name:" style label is more reliable than the generic
  // heuristic below, but only near the top of the document — a CV's
  // References section can list a referee as "Name: Mrs. Catherine Osei",
  // and that's not the candidate. Restrict the label search to roughly
  // the personal-details header block.
  const headerText = text.split("\n").slice(0, 15).join("\n");
  const labelMatch = headerText.match(/\b(?:full\s*name|candidate\s*name|name)\s*[:\-]\s*\[?([A-Za-z][A-Za-z'\-.\s]{2,40}?)\]?\s*(?:\n|$)/i);
  if (labelMatch) {
    const candidate = labelMatch[1].split("\n")[0].trim();
    if (looksLikeName(candidate)) return toTitleCase(candidate);
  }

  const lines = text.split("\n").map(L => L.trim()).filter(Boolean).slice(0, 20);
  for (const line of lines) {
    if (looksLikeName(line)) {
      return toTitleCase(line);
    }
  }

  // Fallback: derive from filename, but only if the filename actually
  // looks like a name ("John_Doe_CV.pdf") rather than a random ID
  // (many bulk-downloaded CVs are just numeric timestamps) — a fabricated
  // "name" from a meaningless filename is worse than leaving it blank.
  let base = fileName.replace(/\.[^.]+$/, "");
  base = base.replace(/[_\-]+/g, " ");
  base = base.replace(/\b(cv|resume|résumé|final|updated|new|copy|version\s?\d*)\b/gi, "");
  base = base.replace(/\s+/g, " ").trim();
  if (base && /[a-zA-Z]{2,}/.test(base)) {
    return toTitleCase(base);
  }
  return "";
}

function toTitleCase(str) {
  return str
    .toLowerCase()
    .split(" ")
    .map(W => W ? W[0].toUpperCase() + W.slice(1) : W)
    .join(" ")
    .trim();
}

function extractFields(text, fileName) {
  const email = extractEmail(text);
  let phone = extractPhone(text);
  let country = extractCountry(text, phone);
  phone = normalizePhoneWithCountry(phone, country);
  if (!country && phone && phone.startsWith("+")) {
    country = extractCountry(text, phone); // re-check now that phone carries a dial code
  }
  const name = extractName(text, fileName);
  return { name, email, phone, country };
}

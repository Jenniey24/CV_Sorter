/* auth.js — shared password-gate logic for index.html (login) and console.html.
 *
 * The password is now checked server-side, in apps-script.gs, against a
 * hash stored in that project's Script Properties — not in this browser,
 * not in any file. That means it's genuinely ONE password shared by
 * everyone who has the link, not a per-device setup. The browser only
 * ever handles the SHA-256 hash of the password, never the plaintext —
 * that hash also doubles as the credential that authorizes writes to
 * your Google Sheet (see the "list"/"append" checks in apps-script.gs),
 * so there's no separate API secret to configure anymore.
 *
 * Requires config.js (APPS_SCRIPT_URL) to be loaded first.
 *
 * Being logged in only lasts for this browser tab's session
 * (sessionStorage) — closing the tab logs you out, same as before.
 */

const AUTH = {
  SESSION_AUTHED_KEY: "cv-sorter-authed",
  SESSION_HASH_KEY: "cv-sorter-pw-hash",
  CONSOLE_PAGE: "console.html",
  LOGIN_PAGE: "index.html",

  async sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(B => B.toString(16).padStart(2, "0")).join("");
  },

  async request(payload) {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    return res.json();
  },

  // { ok, hasPassword }
  async status() {
    return this.request({ action: "authStatus" });
  },

  // First-ever visitor after a fresh deploy calls this to set the one
  // shared password. Fails if a password is already set.
  async setup(password) {
    const hash = await this.sha256(password);
    const res = await this.request({ action: "authSetup", passwordHash: hash });
    if (res && res.ok) this._markAuthed(hash);
    return res;
  },

  async login(password) {
    const hash = await this.sha256(password);
    const res = await this.request({ action: "authLogin", passwordHash: hash });
    if (res && res.ok) this._markAuthed(hash);
    return res;
  },

  // Clears the shared password server-side so a new one can be set.
  // Requires ADMIN_RESET_CODE from apps-script.gs.
  async resetWithAdminCode(adminCode) {
    return this.request({ action: "authReset", adminCode });
  },

  _markAuthed(hash) {
    sessionStorage.setItem(this.SESSION_AUTHED_KEY, "1");
    sessionStorage.setItem(this.SESSION_HASH_KEY, hash);
  },

  isAuthed() {
    return sessionStorage.getItem(this.SESSION_AUTHED_KEY) === "1" &&
      Boolean(sessionStorage.getItem(this.SESSION_HASH_KEY));
  },

  // The password hash for this session — send with any request to
  // apps-script.gs that needs write/read access to the sheet.
  passwordHash() {
    return sessionStorage.getItem(this.SESSION_HASH_KEY) || "";
  },

  logout() {
    sessionStorage.removeItem(this.SESSION_AUTHED_KEY);
    sessionStorage.removeItem(this.SESSION_HASH_KEY);
  },

  goToConsole() {
    location.href = this.CONSOLE_PAGE;
  },

  goToLogin() {
    location.replace(this.LOGIN_PAGE);
  },

  // Call at the very top of console.html, before rendering anything real.
  // Returns true if the visitor is authed; otherwise bounces them to
  // index.html and returns false.
  guard() {
    if (!this.isAuthed()) {
      this.goToLogin();
      return false;
    }
    return true;
  },
};

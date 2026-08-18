/* auth.js — shared password-gate logic for login.html and console.html.
 *
 * Client-side only: this keeps a casual visitor from opening a shared
 * link and browsing candidate data. It is NOT a substitute for real
 * per-user accounts or a server-side check. The password itself is
 * never stored anywhere — only its SHA-256 hash, in this browser's
 * localStorage.
 *
 * IMPORTANT LIMITATION, read this before relying on it: the hash lives
 * in THIS BROWSER's localStorage, not on any server. That means:
 *   - It only locks the app on browsers that have already had a
 *     password set on them. A browser that's never opened the link
 *     before will land on the SET UP screen and let whoever's sitting
 *     there choose a fresh password — there's no server to check
 *     against, so nothing stops that.
 *   - It does not sync between devices or browsers. If you want the
 *     same password to gate everyone's access, you're really relying
 *     on people only opening the link on a device you've already set
 *     up, or on the "screen door" effect of most people not going
 *     digging in dev tools.
 * See the README section "How locked-down is locked" for the full
 * picture, including what's actually enforced server-side (the Sheet
 * API secret).
 */

const AUTH = {
  PASS_HASH_KEY: "cv-sorter-pass-hash",
  SESSION_KEY: "cv-sorter-authed",
  CONSOLE_PAGE: "console.html",
  LOGIN_PAGE: "index.html",

  async sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(B => B.toString(16).padStart(2, "0")).join("");
  },

  hasPassword() {
    return Boolean(localStorage.getItem(this.PASS_HASH_KEY));
  },

  isAuthed() {
    return this.hasPassword() && sessionStorage.getItem(this.SESSION_KEY) === "1";
  },

  async setPassword(P) {
    localStorage.setItem(this.PASS_HASH_KEY, await this.sha256(P));
    sessionStorage.setItem(this.SESSION_KEY, "1");
  },

  async tryLogin(P) {
    const hash = await this.sha256(P);
    if (hash === localStorage.getItem(this.PASS_HASH_KEY)) {
      sessionStorage.setItem(this.SESSION_KEY, "1");
      return true;
    }
    return false;
  },

  logout() {
    sessionStorage.removeItem(this.SESSION_KEY);
  },

  resetDevice() {
    localStorage.removeItem(this.PASS_HASH_KEY);
    sessionStorage.removeItem(this.SESSION_KEY);
  },

  goToConsole() {
    location.href = this.CONSOLE_PAGE;
  },

  goToLogin() {
    location.replace(this.LOGIN_PAGE);
  },

  // Call at the very top of console.html, before rendering anything real.
  // Returns true if the visitor is authed; otherwise bounces them to
  // login.html and returns false.
  guard() {
    if (!this.isAuthed()) {
      this.goToLogin();
      return false;
    }
    return true;
  },
};

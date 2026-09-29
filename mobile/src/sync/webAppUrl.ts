/**
 * Pure: the only address the phone sends its sheet token and entries to — a Google Apps Script
 * web-app deployment ending in `/exec`, on script.google.com (consumer `/macros/s/<id>/exec` or a
 * Workspace `/a/macros/<domain>/s/<id>/exec` / `/a/<domain>/macros/s/<id>/exec`).
 *
 * Same pattern as `DICED_EXEC_URL_RE` in apps-script/Code.gs (used by the sheet's connection dialog
 * and `saveWebAppUrl`), so a crafted `diced://connect` link or a pasted look-alike can never make a
 * phone post its token, weigh-ins or meals to another host. Keep the two in sync.
 */
export const APPS_SCRIPT_EXEC_URL_RE =
  /^https:\/\/script\.google\.com\/(?:macros|a\/macros\/[^/\s]+|a\/[^/\s]+\/macros)\/s\/[A-Za-z0-9_-]+\/exec$/;

/** True for a script.google.com web-app `/exec` URL (surrounding whitespace ignored). */
export function isAppsScriptExecUrl(url: string): boolean {
  return APPS_SCRIPT_EXEC_URL_RE.test(url.trim());
}

/**
 * Helpers for writing operator-facing audit log lines.
 *
 * Strip C0 controls / DEL so user-controlled fields cannot inject newlines
 * or forge additional log entries.
 */

function isControlCharCode(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

/** Remove ASCII control characters (including CR/LF/NUL) and DEL. */
export function sanitizeForLog(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (isControlCharCode(code)) continue;
    out += value[i];
  }
  return out;
}

/** True when the string contains any ASCII C0 control or DEL. */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isControlCharCode(value.charCodeAt(i))) return true;
  }
  return false;
}

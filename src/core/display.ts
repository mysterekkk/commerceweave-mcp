/**
 * Makes untrusted text safe to print in a terminal: C0/C1 control characters, line breaks, ANSI escapes and
 * Unicode format/bidi characters are replaced by visible escapes, so a value can never forge extra lines or
 * hide content in the approval screen.
 */
export function safeDisplay(input: string, max = 400): string {
  let out = '';
  for (const ch of input) {
    const c = ch.codePointAt(0) as number;
    if (c === 10) out += '\\n';
    else if (c === 13) out += '\\r';
    else if (c === 9) out += '\\t';
    else if (c < 32 || (c >= 127 && c <= 159)) out += '\\x' + c.toString(16).padStart(2, '0');
    else if (/\p{Cf}|\p{Zl}|\p{Zp}/u.test(ch)) out += '\\u{' + c.toString(16) + '}';
    else out += ch;
    if (out.length > max) return out.slice(0, max) + '…[truncated]';
  }
  return out;
}

/** True if the text contains control, format or line-separator characters. */
export function hasUnsafeChars(input: string): boolean {
  for (const ch of input) {
    const c = ch.codePointAt(0) as number;
    if (c < 32 || (c >= 127 && c <= 159) || /\p{Cf}|\p{Zl}|\p{Zp}/u.test(ch)) return true;
  }
  return false;
}

/**
 * Lightweight debug logger gated on the ABBENAY_DEBUG environment variable.
 * Output goes to stderr so it never pollutes piped stdout.
 *
 * Enable with:  ABBENAY_DEBUG=1 abbenay chat ...
 * Or via CLI:   abbenay --verbose chat ...
 */

export function debug(...args: unknown[]): void {
  const flag = process.env.ABBENAY_DEBUG;
  if (flag === '1' || flag?.toLowerCase() === 'true') {
    console.error(...args);
  }
}

/** Temporarily set a process.env value for the duration of a test callback. */
export async function withEnv(
  key: string,
  value: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

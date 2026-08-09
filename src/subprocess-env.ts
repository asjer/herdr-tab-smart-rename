const PROVIDER_SECRET_NAMES = new Set([
  "SMART_RENAME_API_KEY",
  "OPENAI_API_KEY",
  "KIMI_API_KEY",
]);

/** Environment for every child process that is not the in-process AI provider. */
export function nonProviderSubprocessEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !PROVIDER_SECRET_NAMES.has(name)),
  );
}

import { ALL_CAPABILITIES, type Capability, type PolicyOptions, type Risk } from "./policy.js";
import type { VerifyCheck } from "./verify.js";

/**
 * Environment adapters for the harness layer.
 *
 * Keeping parsing here (instead of in the CLI and the web server separately)
 * means both entry points get the same policy and the same verification gate,
 * so "it worked in the terminal" also holds in the browser.
 */

const RISKS: Risk[] = ["low", "medium", "high"];

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * `AGENT_CAPABILITIES=fs.read,fs.write,shell` narrows what the model may use;
 * an unset value keeps everything (the user already opted into a local agent).
 * `AGENT_AUTO_APPROVE_RISK=low` runs low-risk commands without asking, while
 * "never" (the default) preserves "every shell command asks first".
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyOptions {
  const allowed = list(env.AGENT_CAPABILITIES).filter((name): name is Capability =>
    (ALL_CAPABILITIES as string[]).includes(name),
  );
  const rawAuto = env.AGENT_AUTO_APPROVE_RISK?.trim().toLowerCase();
  const autoApproveRisk = rawAuto && rawAuto !== "never" && (RISKS as string[]).includes(rawAuto) ? (rawAuto as Risk) : "never";
  return {
    ...(env.AGENT_CAPABILITIES !== undefined ? { allowedCapabilities: allowed } : {}),
    autoApproveRisk,
  };
}

/** The browser toggle can narrow the server's policy, never grant missing capabilities. */
export function webPolicyFromEnv(allowChanges: boolean, env: NodeJS.ProcessEnv = process.env): PolicyOptions {
  const policy = policyFromEnv(env);
  const enabled = allowChanges && env.WEB_ALLOW_TOOLS !== "0";
  const allowed = policy.allowedCapabilities ?? ALL_CAPABILITIES;
  return {
    ...policy,
    allowedCapabilities: enabled ? allowed : allowed.filter((capability) => capability === "fs.read" || capability === "network"),
    autoApproveRisk: enabled ? "high" : "never",
  };
}

/**
 * `AGENT_VERIFY_CHECKS` is `;;`-separated `name=command` pairs, for example:
 * `typecheck=npx tsc --noEmit;;tests=npm test -- --test-reporter=dot`.
 * A single entry without `=` becomes one check named "verify".
 */
export function verificationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { checks: VerifyCheck[]; maxAttempts: number } | undefined {
  const raw = env.AGENT_VERIFY_CHECKS?.trim();
  if (!raw) return undefined;
  const checks: VerifyCheck[] = [];
  for (const entry of raw.split(";;").map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf("=");
    const name = separator > 0 ? entry.slice(0, separator).trim() : "verify";
    const command = separator > 0 ? entry.slice(separator + 1).trim() : entry;
    if (command) checks.push({ name, command });
  }
  if (checks.length === 0) return undefined;
  const rawAttempts = Number.parseInt(env.AGENT_VERIFY_ATTEMPTS ?? "", 10);
  return { checks, maxAttempts: Number.isFinite(rawAttempts) && rawAttempts >= 0 ? rawAttempts : 1 };
}

// Shared helpers for the github skill scripts. Node >= 23.6 (native TS), stdlib only.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface GhOpts {
  /** Exit codes that still carry valid stdout (e.g. `gh pr checks`: 1 = failing, 8 = pending). */
  okCodes?: number[];
}

export async function gh(args: string[], opts: GhOpts = {}): Promise<string> {
  try {
    const { stdout } = await execFileP("gh", args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    // An okCode with empty stdout is not "valid output" — it's a real error
    // (e.g. `pr checks` exits 1 both for failing checks and for a bad PR number).
    if (typeof err.code === "number" && opts.okCodes?.includes(err.code)) {
      if (err.stdout?.trim() || !err.stderr?.trim()) return err.stdout ?? "";
    }
    if (err.code === "ENOENT") throw new Error("gh not found on PATH — install the GitHub CLI");
    const detail =
      err.code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER"
        ? "output exceeded 64MB maxBuffer"
        : truncate((err.stderr || err.stdout || err.message || "").trim(), 2000);
    // Args can embed multi-line GraphQL queries — keep the prefix identifiable, not a dump.
    const cmd = args.map((a) => truncate(a.split("\n")[0], 60)).join(" ");
    throw new Error(`gh ${cmd}\n${detail}`);
  }
}

export async function ghJson<T>(args: string[], opts?: GhOpts): Promise<T> {
  const out = await gh(args, opts);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error(`unexpected non-JSON from gh ${args.slice(0, 3).join(" ")}: ${out.slice(0, 200)}`);
  }
}

export async function resolveRepo(flag?: string): Promise<string> {
  if (flag) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(flag)) throw new Error(`--repo must be owner/repo, got: ${flag}`);
    return flag;
  }
  try {
    return (await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/gh not found|auth login|authentication/i.test(msg)) throw e;
    throw new Error("not inside a repo with a GitHub remote — pass -R owner/repo");
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)} […+${s.length - max} chars]`;
}

/** Wrap a script's main(): print clean errors, exit 1 only on real failure. */
export function run(main: () => Promise<void>): void {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

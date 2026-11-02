// Shared helpers for the github skill scripts. Node >= 23.6 (native TS), stdlib only.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
    // An okCode with empty stdout is not "valid output"; it's a real error
    // (e.g. `pr checks` exits 1 both for failing checks and for a bad PR number).
    if (typeof err.code === "number" && opts.okCodes?.includes(err.code)) {
      if (err.stdout?.trim() || !err.stderr?.trim()) return err.stdout ?? "";
    }
    if (err.code === "ENOENT") throw new Error("gh not found on PATH; install the GitHub CLI");
    const detail =
      err.code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER"
        ? "output exceeded 64MB maxBuffer"
        : truncate((err.stderr || err.stdout || err.message || "").trim(), 2000);
    // Args can embed multi-line GraphQL queries; keep the prefix identifiable, not a dump.
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
    throw new Error("not inside a repo with a GitHub remote; pass -R owner/repo");
  }
}

/** PR number: explicit positional, or the current branch's PR when omitted. */
export async function resolvePr(arg: string | undefined, repoFlag: string | undefined): Promise<number> {
  if (arg !== undefined) {
    const n = Number(arg);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`PR must be a positive number, got: ${arg}`);
    return n;
  }
  // with an explicit -R, "the current branch's PR" would resolve against the
  // cwd repo and silently target the wrong PR; refuse to guess
  if (repoFlag) throw new Error("with -R, also pass the PR number");
  return (await ghJson<{ number: number }>(["pr", "view", "--json", "number"])).number;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)} […+${s.length - max} chars]`;
}

/** Wrap a script's main(): print clean errors, exit 1 only on real failure. */
export function run(main: () => Promise<void>): void {
  // agents pipe these scripts into head/tail; a closed pipe is not a failure
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function cacheDir(sub: string): string {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "better-github-skill", sub);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Atomic, so parallel watchers never read a half-written file. */
export function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

interface Cached {
  etag?: string;
  at: number;
  body: string;
  next: string | null;
}

export interface RestStats {
  /** Requests sent to GitHub. */
  requests: number;
  /** 304 answers: GitHub doesn't count these against the rate limit. */
  unchanged: number;
  /** Reads answered from another process's fresh copy, with no request. */
  shared: number;
}

/**
 * REST reads with ETags kept on disk. A repeat read GitHub answers 304 is free
 * against the primary rate limit, and every process using the same account and
 * URL shares one copy. Rate limits pause the read until GitHub allows it again.
 */
export async function restApi() {
  const host = process.env.GH_HOST || "github.com";
  const token = (await gh(["auth", "token", "-h", host])).trim();
  const base = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  const account = hash(`${host}\0${token}`);
  const dir = cacheDir("http");
  const stats: RestStats = { requests: 0, unchanged: 0, shared: 0 };
  let quota: { limit: number; remaining: number; resetMs: number } | undefined;

  const pause = async (ms: number, why: string) => {
    console.error(`${why}; waiting until ${new Date(Date.now() + ms).toLocaleTimeString()}`);
    await sleep(ms);
  };

  async function get<T>(path: string, freshMs = 0): Promise<{ data: T; next: string | null }> {
    const file = join(dir, `${account}-${hash(path)}.json`);
    const cached = readJson<Cached>(file);
    if (cached && Date.now() - cached.at < freshMs) {
      stats.shared++;
      return { data: JSON.parse(cached.body), next: cached.next };
    }
    for (let backoff = 60_000; ; backoff = Math.min(backoff * 2, 15 * 60_000)) {
      // Background reads leave the last 10% of the hour's budget to interactive work.
      if (quota && quota.remaining < quota.limit * 0.1 && quota.resetMs > Date.now()) {
        await pause(quota.resetMs - Date.now() + 1000, `${quota.remaining} GitHub requests left this hour`);
        quota = undefined;
      }
      const res = await fetch(`${base}/${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      stats.requests++;
      const h = (name: string) => res.headers.get(name);
      const [limit, remaining, reset] = ["limit", "remaining", "reset"].map((k) => Number(h(`x-ratelimit-${k}`)));
      if (h("x-ratelimit-remaining") !== null && h("x-ratelimit-resource") === "core") {
        quota = { limit, remaining, resetMs: reset * 1000 };
      }
      if (res.status === 304 && cached) {
        stats.unchanged++;
        await res.body?.cancel();
        writeJson(file, { ...cached, at: Date.now() });
        return { data: JSON.parse(cached.body), next: cached.next };
      }
      const body = await res.text();
      if (res.ok) {
        const next = h("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
        const entry: Cached = {
          etag: h("etag") ?? undefined,
          at: Date.now(),
          body,
          next: next?.startsWith(`${base}/`) ? next.slice(base.length + 1) : null,
        };
        writeJson(file, entry);
        return { data: JSON.parse(body), next: entry.next };
      }
      if (res.status === 429 || (res.status === 403 && (h("retry-after") || remaining === 0 || /rate limit/i.test(body)))) {
        const wait = h("retry-after")
          ? Number(h("retry-after")) * 1000
          : remaining === 0 && reset * 1000 > Date.now()
            ? reset * 1000 - Date.now() + 1000
            : backoff;
        await pause(wait, `GitHub rate limit (HTTP ${res.status})`);
        continue;
      }
      throw new Error(`GET ${path}: HTTP ${res.status} ${truncate(body.trim(), 300)}`);
    }
  }

  /** Every page of a list endpoint; `pick` pulls the items out of each page. */
  async function getAll<T>(path: string, pick: (page: any) => T[], freshMs = 0): Promise<T[]> {
    const items: T[] = [];
    for (let next: string | null = path; next; ) {
      const page: { data: unknown; next: string | null } = await get(next, freshMs);
      items.push(...pick(page.data));
      next = page.next;
    }
    return items;
  }

  return { get, getAll, stats, account };
}

#!/usr/bin/env node
// Block until a PR has news worth the agent's turn, then print it and exit.
// Polls with conditional REST reads: GitHub answers 304 when nothing changed,
// and 304s don't count against the rate limit, so a quiet PR costs nothing.
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cacheDir, readJson, resolvePr, resolveRepo, restApi, run, sleep, truncate, writeJson } from "./lib.ts";

const USAGE = `usage: pr-watch.ts [pr] [-R owner/repo] [--interval 60s] [--timeout 9m] [--reset] [--json]

Waits until the PR has news, prints it, exits 0. News: a check failed, the
required checks passed, all checks passed, no checks reported 15m after a
push, someone else commented or reviewed, the branch started to conflict, or
the PR merged or closed. Rerun it after acting: news it already printed in
this directory is not repeated, and its reads are cached, so a rerun costs
nothing. Watchers of one PR share reads, even across agents.
  --interval D   time between checks (default 60s)
  --timeout D    give up after D with "no news" (default 9m, 0 = never)
  --reset        forget what earlier runs already reported
  --json         structured output, shape:
                 { repo, pr, head, state: "open"|"merged"|"closed",
                   events: [{kind: "checks-failed", checks: [{name, conclusion, url}]}
                          | {kind: "checks-passed", count, required}
                          | {kind: "no-checks", minutes}
                          | {kind: "comments", comments: [{author, kind, path?, state?, body, url}]}
                          | {kind: "conflicting", base}],
                   stopped?, stats: {minutes, requests, unchanged, shared} }`;

const NO_CHECKS_MS = 15 * 60_000;
const COMMENT_WAKE_LIMIT = 10;
const FAILURE_LIMIT = 8;
const COMMENTS_REREAD_MS = 10 * 60_000;
const PULL_REREAD_MS = 5 * 60_000;
const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "error"]);

interface Issue {
  state: "open" | "closed";
  updated_at: string;
  pull_request?: { merged_at: string | null };
}
interface Pull {
  mergeable: boolean | null;
  head: { sha: string };
  base: { ref: string };
}
interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}
interface Check {
  name: string;
  state: "pass" | "fail" | "pending";
  conclusion: string;
  url: string;
}
interface Comment {
  id: string;
  author: string;
  kind: "comment" | "review" | "review-comment";
  at: string;
  body: string;
  path?: string;
  /** Review verdict: APPROVED, CHANGES_REQUESTED or COMMENTED. */
  state?: string;
  url: string;
}
interface WatchState {
  head: string | null;
  base: string | null;
  pullReadAt: number;
  failed: string[];
  requiredOk: boolean;
  allOk: boolean;
  checksAwaitedSince: number | null;
  conflicting: boolean;
  /** Comments at or before this time were reported, or predate the watch. */
  through: string;
  /** Comments exactly at `through` already reported; GitHub stamps to the second. */
  ids: string[];
  prUpdatedAt: string | null;
  commentsReadAt: number;
  commentWakes: number;
  stopped?: string;
}
type Event =
  | { kind: "checks-failed"; checks: Omit<Check, "state">[] }
  | { kind: "checks-passed"; count: number; required: boolean }
  | { kind: "no-checks"; minutes: number }
  | { kind: "comments"; comments: Omit<Comment, "id" | "at">[] }
  | { kind: "conflicting"; base: string };

function duration(s: string, flag: string): number {
  const m = s.match(/^(\d+)(s|m|h)?$/);
  if (!m) throw new Error(`${flag} takes a duration like 90s, 10m or 2h, got: ${s}`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"]!;
}

const user = (u: { login: string } | null) => u?.login ?? "ghost";

run(async () => {
  const { values: v, positionals } = parseArgs({
    options: {
      repo: { type: "string", short: "R" },
      interval: { type: "string" },
      timeout: { type: "string" },
      reset: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (v.help) return void console.log(USAGE);
  const n = await resolvePr(positionals[0], v.repo);
  const repo = await resolveRepo(v.repo);
  const interval = Math.max(10_000, duration(v.interval ?? "60s", "--interval"));
  const timeout = duration(v.timeout ?? "9m", "--timeout");
  const started = Date.now();
  // Watchers of one PR take turns: a read another one made this interval is reused.
  const fresh = interval - 5000;

  const api = await restApi();
  const viewer = await api
    .get<{ login: string }>("user", 24 * 3_600_000)
    .then((r) => r.data.login.toLowerCase())
    .catch(() => null); // app tokens have no user; then every comment counts

  // What was reported is per directory, so agents in separate worktrees each get every piece of news.
  const where = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
  const stateFile = join(cacheDir("watch"), `${api.account}-${where}-${repo.replace("/", "_")}-${n}.json`);
  if (v.reset) rmSync(stateFile, { force: true });
  const s: WatchState = {
    head: null,
    base: null,
    pullReadAt: 0,
    failed: [],
    requiredOk: false,
    allOk: false,
    checksAwaitedSince: null,
    conflicting: false,
    through: new Date(started).toISOString(),
    ids: [],
    prUpdatedAt: null,
    commentsReadAt: 0,
    commentWakes: 0,
    ...readJson<WatchState>(stateFile),
  };

  const requiredChecks = async (branch: string): Promise<Set<string>> => {
    const b = encodeURIComponent(branch);
    const [rules, classic] = await Promise.all([
      api.getAll(`repos/${repo}/rules/branches/${b}?per_page=100`, (p: any[]) => p, 30 * 60_000).catch(() => []),
      api.get<any>(`repos/${repo}/branches/${b}`, 30 * 60_000).then((r) => r.data).catch(() => null),
    ]);
    return new Set<string>([
      ...rules.flatMap((r: any) =>
        r.type === "required_status_checks" ? r.parameters.required_status_checks.map((c: any) => c.context) : [],
      ),
      ...(classic?.protection?.required_status_checks?.contexts ?? []),
    ]);
  };

  const readChecks = async (sha: string): Promise<Map<string, Check>> => {
    const [runs, status] = await Promise.all([
      api.getAll<CheckRun>(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, (p) => p.check_runs, fresh),
      api.get<any>(`repos/${repo}/commits/${sha}/status?per_page=100`, fresh),
    ]);
    const checks = new Map<string, Check>();
    // A rerun adds a second run under the same name; only the newest one counts.
    for (const r of runs.toSorted((a, b) => a.id - b.id)) {
      const done = r.status === "completed";
      checks.set(r.name, {
        name: r.name,
        state: !done ? "pending" : FAILED.has(r.conclusion ?? "") ? "fail" : "pass",
        conclusion: (done && r.conclusion) || r.status,
        url: r.html_url,
      });
    }
    for (const st of status.data.statuses) {
      checks.set(st.context, {
        name: st.context,
        state: st.state === "success" ? "pass" : st.state === "pending" ? "pending" : "fail",
        conclusion: st.state,
        url: st.target_url ?? "",
      });
    }
    return checks;
  };

  const readComments = async (): Promise<Comment[]> => {
    const all = (path: string) => api.getAll(`repos/${repo}/${path}?per_page=100`, (p: any[]) => p, fresh);
    const [issue, reviews, inline] = await Promise.all([
      all(`issues/${n}/comments`),
      all(`pulls/${n}/reviews`),
      all(`pulls/${n}/comments`),
    ]);
    const comment = (kind: Comment["kind"], c: any, at: string): Comment => ({
      id: `${kind}:${c.id}`,
      author: user(c.user),
      kind,
      at,
      body: c.body ?? "",
      ...(c.path ? { path: c.path } : {}),
      ...(kind === "review" ? { state: c.state } : {}),
      url: c.html_url,
    });
    return [
      ...issue.map((c: any) => comment("comment", c, c.updated_at)),
      // empty COMMENTED reviews only wrap inline comments, which are listed on their own
      ...reviews
        .filter((r: any) => r.submitted_at && (r.body?.trim() || r.state !== "COMMENTED"))
        .map((r: any) => comment("review", r, r.submitted_at)),
      ...inline.map((c: any) => comment("review-comment", c, c.updated_at)),
    ];
  };

  const tick = async (): Promise<{ events: Event[]; state: string; checks: Map<string, Check> }> => {
    // The issue view of a PR changes only when the PR does. The pull view also carries
    // the base branch's tip, so on a busy repo it changes every time main moves.
    const issue = (await api.get<Issue>(`repos/${repo}/issues/${n}`, fresh)).data;
    const now = Date.now();
    if (issue.state !== "open") {
      return { events: [], state: issue.pull_request?.merged_at ? "merged" : "closed", checks: new Map() };
    }
    const changed = issue.updated_at !== s.prUpdatedAt;
    const events: Event[] = [];

    let headMoved = false;
    // A conflict comes from the base moving, which the issue view doesn't show; reread for it.
    if (changed || !s.head || now - s.pullReadAt >= PULL_REREAD_MS) {
      const pr = (await api.get<Pull>(`repos/${repo}/pulls/${n}`, fresh)).data;
      headMoved = pr.head.sha !== s.head;
      if (headMoved) {
        Object.assign(s, { head: pr.head.sha, failed: [], requiredOk: false, allOk: false, checksAwaitedSince: now });
      }
      s.base = pr.base.ref;
      if (pr.mergeable === false && !s.conflicting) events.push({ kind: "conflicting", base: pr.base.ref });
      // null: GitHub is still computing mergeability after a push, so ask again next time
      if (pr.mergeable !== null) s.conflicting = !pr.mergeable;
      s.pullReadAt = pr.mergeable === null ? 0 : now;
    }
    const [checks, required] = await Promise.all([readChecks(s.head!), requiredChecks(s.base!)]);

    const list = [...checks.values()];
    if (list.length > 0) {
      s.checksAwaitedSince = null;
      const failed = list.filter((c) => c.state === "fail");
      const newly = failed.filter((c) => !s.failed.includes(c.name));
      if (newly.length > 0) {
        events.push({ kind: "checks-failed", checks: newly.map(({ name, conclusion, url }) => ({ name, conclusion, url })) });
      }
      s.failed = failed.map((c) => c.name);
      const allOk = failed.length === 0 && list.every((c) => c.state === "pass");
      const requiredOk = required.size > 0 && [...required].every((name) => checks.get(name)?.state === "pass");
      if (allOk && !s.allOk) events.push({ kind: "checks-passed", count: list.length, required: false });
      else if (requiredOk && !s.requiredOk) events.push({ kind: "checks-passed", count: required.size, required: true });
      Object.assign(s, { allOk, requiredOk });
    } else if (s.checksAwaitedSince !== null && now - s.checksAwaitedSince >= NO_CHECKS_MS) {
      events.push({ kind: "no-checks", minutes: Math.round((now - s.checksAwaitedSince) / 60_000) });
      s.checksAwaitedSince = null;
    }

    // Comments, reviews and their edits move the PR's updated_at; read them only then.
    if (changed || now - s.commentsReadAt >= COMMENTS_REREAD_MS) {
      const through = Date.parse(s.through);
      const news = (await readComments()).filter((c) => {
        const at = Date.parse(c.at);
        return (at > through || (at === through && !s.ids.includes(c.id))) && c.author.toLowerCase() !== viewer;
      });
      if (news.length > 0) {
        events.push({ kind: "comments", comments: news.map(({ id, at, ...c }) => c) });
        const latest = news.reduce((max, c) => (Date.parse(c.at) > Date.parse(max) ? c.at : max), s.through);
        s.ids = [...(latest === s.through ? s.ids : []), ...news.filter((c) => c.at === latest).map((c) => c.id)];
        s.through = latest;
      }
      Object.assign(s, { prUpdatedAt: issue.updated_at, commentsReadAt: now });
    }

    // Bounds bot reply loops: comment-only news 10 times running ends the watch.
    const commentsOnly = events.length > 0 && events.every((e) => e.kind === "comments");
    s.commentWakes = headMoved || (events.length > 0 && !commentsOnly) ? 0 : s.commentWakes + (commentsOnly ? 1 : 0);
    if (s.commentWakes >= COMMENT_WAKE_LIMIT) {
      s.stopped = `${COMMENT_WAKE_LIMIT} comment-only updates in a row (a bot reply loop?); --reset watches again`;
    }
    return { events, state: "open", checks };
  };

  let failures = 0;
  let result: Awaited<ReturnType<typeof tick>> | undefined;
  while (!s.stopped) {
    try {
      result = await tick();
      failures = 0;
    } catch (e) {
      if (++failures >= FAILURE_LIMIT) throw new Error(`could not read the PR ${FAILURE_LIMIT} times in a row: ${e instanceof Error ? e.message : e}`);
      await sleep(Math.min(20_000 * 2 ** (failures - 1), 15 * 60_000));
      continue;
    }
    if (result.state !== "open") rmSync(stateFile, { force: true });
    else writeJson(stateFile, s);
    if (result.state !== "open" || result.events.length > 0) break;
    if (timeout > 0 && Date.now() - started + interval > timeout) break;
    await sleep(interval);
  }

  const state = result?.state ?? "open";
  const events = result?.events ?? [];
  const stats = { minutes: Math.round((Date.now() - started) / 60_000), ...api.stats };
  if (v.json) {
    return void console.log(
      JSON.stringify({ repo, pr: n, head: s.head, state, events, ...(s.stopped ? { stopped: s.stopped } : {}), stats }, null, 2),
    );
  }

  const at = s.head ? ` @ ${s.head.slice(0, 7)}` : "";
  const summary =
    state !== "open" ? `${state}; watch over` : events.length > 0 ? events.map((e) => e.kind.replace("-", " ")).join(", ") : "no news";
  console.log(`${repo}#${n}${at}: ${summary}`);
  const listed = <T>(items: T[], line: (item: T) => string) => {
    for (const item of items.slice(0, 10)) console.log(`  - ${line(item)}`);
    if (items.length > 10) console.log(`  - and ${items.length - 10} more`);
  };
  for (const e of events) {
    if (e.kind === "checks-failed") {
      console.log("- checks failed:");
      listed(e.checks, (c) => `${c.name}${c.conclusion === "failure" ? "" : ` (${c.conclusion})`} ${c.url}`);
    }
    if (e.kind === "checks-passed") {
      const left = [...(result?.checks.values() ?? [])].filter((c) => c.state === "pending").length;
      console.log(`- all ${e.count} ${e.required ? "required " : ""}checks passed${left ? ` (${left} others still running)` : ""}`);
    }
    if (e.kind === "no-checks") {
      console.log(`- no checks reported ${e.minutes}m after the push (none configured, or a fork PR waiting for approval)`);
    }
    if (e.kind === "comments") {
      console.log(`- ${e.comments.length} new comment${e.comments.length === 1 ? "" : "s"} (pr-threads.ts has them in full):`);
      listed(e.comments, (c) => {
        const body = truncate(c.body.replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").trim(), 200);
        const who = `@${c.author}${c.path ? ` on ${c.path}` : ""}${c.state ? ` reviewed (${c.state})` : ""}`;
        return `${who}${body ? `: ${body}` : ""} ${c.url}`;
      });
    }
    if (e.kind === "conflicting") console.log(`- the branch now conflicts with ${e.base}`);
  }
  if (s.stopped) console.log(`- watch stopped: ${s.stopped}`);
  if (state === "open" && events.length === 0 && !s.stopped) {
    const by = (k: Check["state"]) => [...(result?.checks.values() ?? [])].filter((c) => c.state === k).length;
    console.log(`- checks: ${by("pending")} running, ${by("pass")} passed, ${by("fail")} failed; rerun to keep watching`);
  }
  const { requests, unchanged, shared } = api.stats;
  console.log(
    `watched ${stats.minutes}m · ${requests} GitHub requests, ${unchanged} unchanged (free), ${requests - unchanged} counted` +
      (shared ? ` · ${shared} reads reused from a recent one` : ""),
  );
});

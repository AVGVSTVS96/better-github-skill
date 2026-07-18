#!/usr/bin/env node
// Failing CI drilldown: checks → failing jobs/steps → log snippet each.
// Full job logs are saved to files (paths printed); rg those instead of re-fetching.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gh, ghJson, resolveRepo, run } from "./lib.ts";

const USAGE = `usage: ci-failures.ts [run-id] [--pr N] [-R owner/repo] [--json]

Failing GitHub Actions jobs with log snippets, for a run id, a PR, or the
current branch's PR. Exits 0 when the report succeeds, even if CI is red.`;

const FAILING = new Set(["failure", "cancelled", "timed_out", "action_required"]);
const MARKERS = /##\[error\]|\berror\b|\bfail(?:ed|ure)?\b|exception|traceback|panic|fatal/i;

interface Check {
  name: string;
  state: string;
  bucket: string;
  link: string;
}
interface Job {
  name: string;
  conclusion: string;
  databaseId: number;
  url: string;
  steps: { name: string; conclusion: string }[];
}
interface RunView {
  workflowName: string;
  conclusion: string;
  url: string;
  jobs: Job[];
}

// The tail of a failed log is post-job cleanup noise; the story sits just above
// the last error marker, so the context window is asymmetric.
function snippet(log: string, before = 40, after = 5, cap = 100): string {
  const lines = log.split("\n");
  const lastMatch = (re: RegExp) => {
    for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i;
    return -1;
  };
  let hit = lastMatch(/##\[error\]/);
  if (hit === -1) hit = lastMatch(MARKERS);
  const window =
    hit === -1 ? lines.slice(-cap) : lines.slice(Math.max(0, hit - before), Math.min(lines.length, hit + after + 1));
  return window.slice(-cap).join("\n");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "job";
}

async function jobLog(repo: string, job: Job, logDir: string) {
  try {
    const log = await gh(["api", `repos/${repo}/actions/jobs/${job.databaseId}/logs`]);
    if (log.startsWith("PK")) return { error: "log came back as a zip archive; open the job URL instead" };
    const file = join(logDir, `${job.databaseId}-${slug(job.name)}.log`);
    writeFileSync(file, log);
    return { file, lines: log.split("\n").length, snippet: snippet(log) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) return { error: "log not available yet (job still running?)" };
    return { error: msg.split("\n").slice(-1)[0] };
  }
}

async function analyzeRun(repo: string, runId: string, checkNames: string[], logDir: string) {
  const rv = await ghJson<RunView>(["run", "view", runId, "-R", repo, "--json", "jobs,workflowName,conclusion,url"]);
  const failingJobs = rv.jobs.filter((j) => FAILING.has(j.conclusion));
  const jobs = await Promise.all(
    failingJobs.map(async (j) => ({
      name: j.name,
      conclusion: j.conclusion,
      url: j.url,
      failedSteps: j.steps.filter((s) => FAILING.has(s.conclusion)).map((s) => s.name),
      log: await jobLog(repo, j, logDir),
    })),
  );
  return { runId, workflow: rv.workflowName, conclusion: rv.conclusion, url: rv.url, checks: checkNames, jobs };
}
type RunResult = Awaited<ReturnType<typeof analyzeRun>>;
type RunEntry = RunResult | { runId: string; checks: string[]; error: string };

run(async () => {
  const { values: v, positionals } = parseArgs({
    options: {
      pr: { type: "string" },
      repo: { type: "string", short: "R" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (v.help) return void console.log(USAGE);
  const repo = await resolveRepo(v.repo);
  const runId = positionals[0];
  const logDir = join(tmpdir(), "gh-ci");
  mkdirSync(logDir, { recursive: true });

  // resolve the failing runs: explicit run id, or a PR's failing checks
  const runs = new Map<string, string[]>(); // run id → check names
  const external: Check[] = [];
  let prNum: number | undefined;
  if (runId) {
    if (!/^\d+$/.test(runId)) throw new Error(USAGE);
    runs.set(runId, []);
  } else {
    if (v.pr && !/^\d+$/.test(v.pr)) throw new Error(`--pr must be a number, got: ${v.pr}`);
    // with an explicit -R, "the current branch's PR" would resolve against the
    // cwd repo and silently target the wrong PR; refuse to guess
    if (!v.pr && v.repo) throw new Error("with -R, also pass --pr N or a run id");
    prNum = v.pr ? Number(v.pr) : (await ghJson<{ number: number }>(["pr", "view", "--json", "number"])).number;
    const raw = await gh(["pr", "checks", String(prNum), "-R", repo, "--json", "name,state,bucket,link"], {
      okCodes: [1, 8],
    }).catch((e: unknown) => {
      // "no checks reported" is a successful report, not a failure
      if (e instanceof Error && /no checks reported/i.test(e.message)) return "[]";
      throw e;
    });
    const checks: Check[] = JSON.parse(raw || "[]");
    for (const c of checks.filter((c) => c.bucket === "fail")) {
      const m = c.link?.match(/\/actions\/runs\/(\d+)/);
      if (m) runs.set(m[1], [...(runs.get(m[1]) ?? []), c.name]);
      else external.push(c);
    }
    if (runs.size === 0 && external.length === 0) {
      if (v.json) return void console.log(JSON.stringify({ repo, pr: prNum, runs: [], external: [] }, null, 2));
      return void console.log(
        `${repo} PR #${prNum}: ${checks.length === 0 ? "no checks reported" : "no failing checks"}`,
      );
    }
  }

  // one dead run (deleted, expired retention) degrades to an error entry, not a dead report
  const results: RunEntry[] = await Promise.all(
    [...runs].map(async ([id, names]) => {
      try {
        return await analyzeRun(repo, id, names, logDir);
      } catch (e) {
        return { runId: id, checks: names, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  if (v.json) {
    return void console.log(JSON.stringify({ repo, pr: prNum, runs: results, external }, null, 2));
  }

  const prLabel = prNum ? ` PR #${prNum}` : "";
  console.log(`${repo}${prLabel}: ${results.length} run${results.length === 1 ? "" : "s"} analyzed\n`);
  for (const r of results) {
    if ("error" in r) {
      console.log(`✗ could not analyze run ${r.runId}: ${r.error}\n`);
      continue;
    }
    if (r.jobs.length === 0 && !FAILING.has(r.conclusion)) {
      console.log(`○ ${r.workflow} · run ${r.runId} concluded ${r.conclusion || "in progress"}, nothing to report\n`);
      continue;
    }
    const via = r.checks.length ? ` (checks: ${r.checks.join(", ")})` : "";
    console.log(`✗ ${r.workflow} · run ${r.runId} · ${r.conclusion}${via}`);
    console.log(`  ${r.url}`);
    if (r.jobs.length === 0) console.log("  no failing jobs; failure is at the workflow level (startup/config?)");
    for (const j of r.jobs) {
      const steps = j.failedSteps.length ? `, failed step: ${j.failedSteps.join(", ")}` : "";
      console.log(`  job: ${j.name} (${j.conclusion})${steps}`);
      if ("error" in j.log) {
        console.log(`    log: ${j.log.error}`);
      } else {
        console.log(`    log: ${j.log.file} (${j.log.lines} lines)`);
        console.log(`    ┄ snippet ┄`);
        console.log(j.log.snippet.replace(/^/gm, "    "));
      }
    }
    console.log();
  }
  for (const c of external) console.log(`✗ ${c.name} is an external check (not GitHub Actions): ${c.link || "(no link)"}`);
});

#!/usr/bin/env node
// One-shot PR state: metadata, mergeability, checks, files, reviews, comments, thread counts.
// Replaces hand-assembled `gh pr view --json` field sets and multi-call composites.
import { parseArgs } from "node:util";
import { gh, ghJson, resolveRepo, run, truncate } from "./lib.ts";

const USAGE = `usage: pr-snapshot.ts <pr> [-R owner/repo] [--full] [--json]

Everything about a PR in one call.
  --full   don't truncate body/comment text
  --json   structured output`;

const FIELDS =
  "number,title,state,isDraft,author,url,createdAt,baseRefName,headRefName,headRefOid," +
  "mergeable,mergeStateStatus,reviewDecision,additions,deletions,changedFiles,files,reviews,comments,body";

interface Pr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: { login: string };
  url: string;
  createdAt: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { path: string; additions: number; deletions: number }[];
  reviews: { author: { login: string } | null; state: string }[];
  comments: { author: { login: string } | null; createdAt: string; body: string }[];
  body: string;
}
interface Check {
  name: string;
  state: string;
  bucket: string;
}

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved } }
    }
  }
}`;

async function fetchThreadStats(repo: string, pr: number) {
  const [owner, name] = repo.split("/");
  const data = JSON.parse(
    await gh([
      "api", "graphql",
      "-f", `query=${THREADS_QUERY}`,
      // -f (raw string) for owner/repo: -F would coerce all-digit names like "2048" to Int
      "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `number=${pr}`,
    ]),
  );
  const conn = data.data.repository.pullRequest.reviewThreads;
  const nodes: { isResolved: boolean }[] = conn.nodes;
  return {
    open: nodes.filter((n) => !n.isResolved).length,
    total: nodes.length,
    capped: conn.pageInfo.hasNextPage as boolean,
  };
}

run(async () => {
  const { values: v, positionals } = parseArgs({
    options: {
      repo: { type: "string", short: "R" },
      full: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (v.help) return void console.log(USAGE);
  const n = Number(positionals[0]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(USAGE);
  const repo = await resolveRepo(v.repo);

  const [pr, checksRaw, threads] = await Promise.all([
    ghJson<Pr>(["pr", "view", String(n), "-R", repo, "--json", FIELDS]),
    // exits 1 = failing checks, 8 = pending — both still emit valid JSON.
    // "no checks reported" is benign; any other checks error is real and must surface.
    gh(["pr", "checks", String(n), "-R", repo, "--json", "name,state,bucket"], { okCodes: [1, 8] }).catch(
      (e: unknown) => {
        if (e instanceof Error && /no checks reported/i.test(e.message)) return "[]";
        throw e;
      },
    ),
    fetchThreadStats(repo, n),
  ]);
  const checks: Check[] = JSON.parse(checksRaw || "[]");

  // latest submitted review per author
  const latestReview = new Map<string, string>();
  for (const r of pr.reviews) {
    if (r.state !== "PENDING") latestReview.set(r.author?.login ?? "ghost", r.state);
  }

  if (v.json) {
    return void console.log(
      JSON.stringify(
        {
          ...pr,
          checks,
          threads,
          reviewsLatest: Object.fromEntries(latestReview),
        },
        null,
        2,
      ),
    );
  }

  const draft = pr.isDraft ? " (draft)" : "";
  console.log(`${repo}#${pr.number} — ${pr.title}`);
  console.log(`${pr.state}${draft} · @${pr.author.login} · created ${pr.createdAt.slice(0, 10)} · ${pr.url}`);
  console.log(`${pr.baseRefName} ← ${pr.headRefName} @ ${pr.headRefOid.slice(0, 12)}`);
  console.log(
    `mergeable ${pr.mergeable} · mergeState ${pr.mergeStateStatus} · review ${pr.reviewDecision || "NONE"}`,
  );

  const byBucket = new Map<string, Check[]>();
  for (const c of checks) byBucket.set(c.bucket, [...(byBucket.get(c.bucket) ?? []), c]);
  const counts = ["pass", "fail", "pending", "skipping", "cancel"]
    .map((b) => [b, byBucket.get(b)?.length ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([b, count]) => `${count} ${b}`)
    .join(" · ");
  console.log(`checks: ${counts || "none reported"}`);
  for (const c of byBucket.get("fail") ?? []) console.log(`  ✗ ${c.name}`);

  console.log(`threads: ${threads.open} open / ${threads.total}${threads.capped ? "+" : ""}`);

  console.log(`files: ${pr.changedFiles} (+${pr.additions} −${pr.deletions})`);
  for (const f of pr.files.slice(0, 50)) console.log(`  +${f.additions} −${f.deletions}  ${f.path}`);
  if (pr.files.length > 50) console.log(`  … ${pr.files.length - 50} more files`);

  if (latestReview.size > 0) {
    const line = [...latestReview].map(([a, s]) => `${a} ${s}`).join(" · ");
    console.log(`reviews: ${line}`);
  }

  if (pr.comments.length > 0) {
    console.log(`comments: ${pr.comments.length}${pr.comments.length > 5 ? " (last 5)" : ""}`);
    for (const c of pr.comments.slice(-5)) {
      const body = v.full ? c.body : truncate(c.body, 400);
      console.log(`  @${c.author?.login ?? "ghost"} ${c.createdAt.slice(0, 10)}: ${body.replace(/\n/g, "\n    ")}`);
    }
  }

  if (pr.body) {
    const body = v.full ? pr.body : truncate(pr.body, 600);
    console.log(`body:\n  ${body.replace(/\n/g, "\n  ")}`);
  }
});

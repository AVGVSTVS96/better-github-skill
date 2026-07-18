#!/usr/bin/env node
// Review threads with resolution state — porcelain gh can't get isResolved/isOutdated.
import { parseArgs } from "node:util";
import { gh, resolveRepo, run, truncate } from "./lib.ts";

const USAGE = `usage: pr-threads.ts <pr> [-R owner/repo] [--unresolved] [--author login] [--since ISO] [--full] [--json]

Review threads for a PR, with isResolved/isOutdated per thread.
  --unresolved   only unresolved threads
  --author X     only threads with a comment by X
  --since TS     only threads with a comment at/after TS (ISO 8601)
  --full         don't truncate comment bodies
  --json         structured output`;

interface Comment {
  author: string;
  createdAt: string;
  body: string;
}
interface Thread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  moreComments: boolean;
  comments: Comment[];
}

const QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved isOutdated path line originalLine
          comments(first: 50) {
            pageInfo { hasNextPage }
            nodes { author { login } createdAt body }
          }
        }
      }
    }
  }
}`;

async function fetchThreads(repo: string, pr: number): Promise<Thread[]> {
  const [owner, name] = repo.split("/");
  const threads: Thread[] = [];
  let cursor: string | null = null;
  do {
    const data = JSON.parse(
      await gh([
        "api", "graphql",
        "-f", `query=${QUERY}`,
        // -f (raw string) for owner/repo: -F would coerce all-digit names like "2048" to Int
        "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `number=${pr}`,
        ...(cursor ? ["-f", `cursor=${cursor}`] : []),
      ]),
    );
    const conn = data.data.repository.pullRequest.reviewThreads;
    for (const n of conn.nodes) {
      threads.push({
        isResolved: n.isResolved,
        isOutdated: n.isOutdated,
        path: n.path,
        line: n.line,
        originalLine: n.originalLine,
        moreComments: n.comments.pageInfo.hasNextPage,
        comments: n.comments.nodes.map((c: { author: { login: string } | null; createdAt: string; body: string }) => ({
          author: c.author?.login ?? "ghost",
          createdAt: c.createdAt,
          body: c.body,
        })),
      });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

run(async () => {
  const { values: v, positionals } = parseArgs({
    options: {
      repo: { type: "string", short: "R" },
      unresolved: { type: "boolean" },
      author: { type: "string" },
      since: { type: "string" },
      full: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (v.help) return void console.log(USAGE);
  const pr = Number(positionals[0]);
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(USAGE);
  const repo = await resolveRepo(v.repo);

  let threads = await fetchThreads(repo, pr);
  const total = threads.length;
  if (v.unresolved) threads = threads.filter((t) => !t.isResolved);
  if (v.author) threads = threads.filter((t) => t.comments.some((c) => c.author === v.author));
  if (v.since) {
    const since = Date.parse(v.since);
    if (Number.isNaN(since)) throw new Error(`--since is not a date: ${v.since}`);
    threads = threads.filter((t) => t.comments.some((c) => Date.parse(c.createdAt) >= since));
  }

  if (v.json) return void console.log(JSON.stringify(threads, null, 2));

  const open = threads.filter((t) => !t.isResolved).length;
  const outdated = threads.filter((t) => t.isOutdated).length;
  console.log(`${repo}#${pr} — ${threads.length}/${total} threads · ${open} open · ${outdated} outdated\n`);
  if (threads.length === 0) {
    return void console.log(total === 0 ? "no review threads" : "no threads match the filters");
  }
  threads.forEach((t, i) => {
    const state = t.isResolved ? "RESOLVED" : "OPEN";
    const outdatedTag = t.isOutdated ? " · outdated" : "";
    const loc = t.line ?? (t.originalLine != null ? `${t.originalLine} (original)` : "?");
    console.log(`[${i + 1}] ${state}${outdatedTag} — ${t.path}:${loc}`);
    for (const c of t.comments) {
      const body = v.full ? c.body : truncate(c.body, 600);
      console.log(`  @${c.author} (${c.createdAt.slice(0, 10)}): ${body.replace(/\n/g, "\n    ")}`);
    }
    if (t.moreComments) console.log("  … thread has >50 comments, rest omitted (--json shows the same cap)");
    console.log();
  });
});

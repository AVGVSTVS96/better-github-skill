#!/usr/bin/env node
// The review conversation for a PR: review bodies, issue comments, and inline
// threads with resolution state (isResolved/isOutdated; porcelain gh can't get it).
import { parseArgs } from "node:util";
import { gh, resolveRepo, run, truncate } from "./lib.ts";

const USAGE = `usage: pr-threads.ts <pr> [-R owner/repo] [--unresolved] [--author login] [--since ISO] [--full] [--json]

Review conversation for a PR: review bodies, issue comments, and inline
threads with isResolved/isOutdated per thread.
  --unresolved   only unresolved threads (omits review bodies and comments)
  --author X     only items by X (threads: any comment by X)
  --since TS     only items with activity at/after TS (ISO 8601)
  --full         don't truncate bodies
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
interface ConvoItem {
  kind: "review" | "comment";
  /** Review state (APPROVED, CHANGES_REQUESTED, COMMENTED); reviews only. */
  state?: string;
  author: string;
  createdAt: string;
  body: string;
}

const QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String, $withConvo: Boolean!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: 50) @include(if: $withConvo) {
        pageInfo { hasPreviousPage }
        nodes { author { login } state submittedAt body }
      }
      comments(last: 50) @include(if: $withConvo) {
        pageInfo { hasPreviousPage }
        nodes { author { login } createdAt body }
      }
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

interface Conversation {
  convo: ConvoItem[];
  /** True when reviews or comments exist beyond the last-50 window. */
  moreConvo: boolean;
  threads: Thread[];
}

async function fetchConversation(repo: string, pr: number): Promise<Conversation> {
  const [owner, name] = repo.split("/");
  const convo: ConvoItem[] = [];
  const threads: Thread[] = [];
  let moreConvo = false;
  let cursor: string | null = null;
  let firstPage = true;
  do {
    const data = JSON.parse(
      await gh([
        "api", "graphql",
        "-f", `query=${QUERY}`,
        // -f (raw string) for owner/repo: -F would coerce all-digit names like "2048" to Int
        "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `number=${pr}`,
        // reviews/comments aren't paginated by the thread cursor; fetch them once
        "-F", `withConvo=${firstPage}`,
        ...(cursor ? ["-f", `cursor=${cursor}`] : []),
      ]),
    );
    const p = data.data.repository.pullRequest;
    if (firstPage) {
      for (const r of p.reviews.nodes) {
        // PENDING = the viewer's own draft; empty bodies carry no words (state lives in pr-snapshot)
        if (r.state === "PENDING" || !r.body?.trim()) continue;
        convo.push({
          kind: "review",
          state: r.state,
          author: r.author?.login ?? "ghost",
          createdAt: r.submittedAt,
          body: r.body,
        });
      }
      for (const c of p.comments.nodes) {
        convo.push({
          kind: "comment",
          author: c.author?.login ?? "ghost",
          createdAt: c.createdAt,
          body: c.body,
        });
      }
      moreConvo = p.reviews.pageInfo.hasPreviousPage || p.comments.pageInfo.hasPreviousPage;
      convo.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    }
    const conn = p.reviewThreads;
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
    firstPage = false;
  } while (cursor);
  return { convo, moreConvo, threads };
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

  let { convo, moreConvo, threads } = await fetchConversation(repo, pr);
  const totalThreads = threads.length;
  if (v.unresolved) {
    threads = threads.filter((t) => !t.isResolved);
    convo = [];
  }
  if (v.author) {
    convo = convo.filter((i) => i.author === v.author);
    threads = threads.filter((t) => t.comments.some((c) => c.author === v.author));
  }
  if (v.since) {
    const since = Date.parse(v.since);
    if (Number.isNaN(since)) throw new Error(`--since is not a date: ${v.since}`);
    convo = convo.filter((i) => Date.parse(i.createdAt) >= since);
    threads = threads.filter((t) => t.comments.some((c) => Date.parse(c.createdAt) >= since));
  }

  if (v.json) return void console.log(JSON.stringify({ conversation: convo, threads }, null, 2));

  const reviews = convo.filter((i) => i.kind === "review").length;
  const comments = convo.length - reviews;
  const open = threads.filter((t) => !t.isResolved).length;
  const outdated = threads.filter((t) => t.isOutdated).length;
  const threadStat = `${threads.length}/${totalThreads} threads (${open} open · ${outdated} outdated)`;
  const convoStat = v.unresolved
    ? ""
    : `${reviews} review ${reviews === 1 ? "body" : "bodies"} · ${comments} comment${comments === 1 ? "" : "s"} · `;
  console.log(`${repo}#${pr}: ${convoStat}${threadStat}\n`);
  if (convo.length === 0 && threads.length === 0) {
    return void console.log(totalThreads === 0 ? "no review activity" : "nothing matches the filters");
  }

  for (const item of convo) {
    const tag = item.kind === "review" ? `[review · ${item.state}]` : "[comment]";
    const body = v.full ? item.body : truncate(item.body, 600);
    console.log(`${tag} @${item.author} (${item.createdAt.slice(0, 10)})`);
    console.log(`  ${body.replace(/\n/g, "\n  ")}\n`);
  }
  if (moreConvo && !v.unresolved) {
    console.log("… reviews/comments older than the last 50 omitted\n");
  }

  threads.forEach((t, i) => {
    const state = t.isResolved ? "RESOLVED" : "OPEN";
    const outdatedTag = t.isOutdated ? " · outdated" : "";
    const loc = t.line ?? (t.originalLine != null ? `${t.originalLine} (original)` : "?");
    console.log(`[${i + 1}] ${state}${outdatedTag} · ${t.path}:${loc}`);
    for (const c of t.comments) {
      const body = v.full ? c.body : truncate(c.body, 600);
      console.log(`  @${c.author} (${c.createdAt.slice(0, 10)}): ${body.replace(/\n/g, "\n    ")}`);
    }
    if (t.moreComments) console.log("  … thread has >50 comments, rest omitted (--json shows the same cap)");
    console.log();
  });
});

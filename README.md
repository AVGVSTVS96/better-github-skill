# better-github-skill: gh, optimized for coding agents

Built from an analysis of **1,843 `gh` calls across real agent sessions**,
better-github-skill reduces context window usage and returns agent-optimized
output for the GitHub workflows agents run most:

- **pr-snapshot** returns a PR's full state in one call: metadata,
  mergeability, checks, files, reviews, and thread counts as a few dozen
  dense lines, replacing the 3-5 command loop and raw JSON dumps it takes
  to assemble the same picture.
- **pr-threads** returns the full review conversation in one call: review
  bodies, issue comments, and unresolved inline threads, using the
  resolution state porcelain `gh` can't surface. Resolved and outdated
  threads stay out of context by default (the header counts what `--all`
  would add), and bodies are truncated at the point of diminishing returns.
  Snapshot is the PR's state; threads is everything reviewers wrote.
- **pr-watch** waits on a PR the way T3 Code's PR watching does: it blocks
  until something worth the agent's turn happens (a check failed, the
  required or all checks passed, someone else commented or reviewed, the
  branch conflicts, the PR merged or closed), prints it and exits. It reads
  with conditional requests, which GitHub doesn't charge for when nothing
  changed, so a quiet PR costs next to nothing; numbers below.
- **ci-failures** returns the failing jobs, their failed steps, and an
  error-anchored ~45-line snippet per job; full logs are written to disk
  and referenced by path, so 10k lines of CI output never enter context.
  `--list` shows recent runs with conclusions, replacing the `gh run list
  --json` field-guessing that otherwise precedes every drilldown.

For everything the scripts don't cover, agents use raw `gh` directly, and
SKILL.md hardens that too: 13 gotchas mined from the same sessions, each a
real failure mode (SIGPIPE truncation, exit-code semantics, silent GET→POST
flips) with the working alternative, so agents skip the retry loops instead
of rediscovering them.

| | raw gh loop | with the skill |
|---|---|---|
| tool calls per flow | 3-5 + retries | 1 |
| context consumed | full logs, diffs, JSON dumps | bounded snippets, files on disk |
| false-error retries | SIGPIPE / exit-code noise | none; exit 0 when the report succeeds |
| latency | sequential multi-turn | parallel, single turn |

## Rate limits: what waiting on a PR costs

Every agent on a GitHub account shares 5,000 REST requests and 5,000
GraphQL points an hour. The usual ways agents wait on a PR spend that
fast. Measured side by side on a live
[pingdotgg/t3code](https://github.com/pingdotgg/t3code) PR, from a push
through CI to review comments, same 15 minutes:

| how the agent waits | counted against the limit | per hour of watching |
|---|---|---|
| `gh run watch` (polls every 3s, no caching) | 63 REST requests in its first minute | ~3,800 |
| `gh pr checks --watch` (every 10s; exits when CI ends) | 22 GraphQL points in 3.6 min | ~370 |
| `gh pr view --json …` every 60s | 15 GraphQL points | 60 |
| **`pr-watch.ts`** (every 60s) | **19 of 61 requests** (42 answered 304, free) | **~12 quiet** |

pr-watch's 19 include its cold start (~10 reads), CI progress and a
review comment; once quiet it spent 2 in 10 minutes. It also covers what
the others don't: comments, reviews, conflicts, required checks.

How, mostly borrowed from T3 Code's PR watching (`watch_pull_request`):

- **Conditional requests.** Every read sends the ETag of the last answer;
  GitHub replies 304 when nothing changed, and 304s don't count. ETags
  live on disk, so reruns and parallel agents watching one PR share them,
  and a read another watcher made this interval is reused with no request.
- **A cheap "anything changed?" probe.** The issue view of a PR changes
  only when the PR does; the pull view embeds the base branch's tip, so on
  a busy repo it changes every time main moves (it answered 200 every 15s
  where the issue view answered 304). pr-watch probes the issue view and
  reads the pull view only on a change, or every 5 minutes for conflicts.
  Comments and reviews are read only when the PR's `updated_at` moves.
- **Wakes only for news**: a failed check, the required or all checks
  passing, someone else's comment or review, a new conflict, merge or
  close, or no checks 15 minutes after a push. Your own comments don't
  count; reruns never repeat news; 10 comment-only wakes in a row end the
  watch, so two bots can't ping-pong an agent forever.
- **Limits pause, never fail.** It honors `retry-after` and
  `x-ratelimit-reset`, backs off a minute and doubling on secondary limits,
  and leaves the last 10% of the hour's budget to interactive work.
  Failed reads back off from 20s to 15 minutes and give up after 8.

SKILL.md adds the rest: never `gh run watch` or sleep loops, `gh api
rate_limit` is free, `gh api --cache` for repeat reads, and GitHub's
second cap of ~80 posts a minute (one review with 119 inline comments was
refused on every try), so agents post one at a time and batch findings.

## Why these three (the data)

The mining covered ~7 months of Claude Code and Codex session transcripts.
The scripts target the highest-frequency failure classes actually observed:

| observed pattern | count | script |
|---|---|---|
| `reviewThreads` GraphQL hand-retyped from scratch (7 distinct failure modes) | 62–78× | `pr-threads.ts` |
| improvised `pr view --json` field-set guessing (40+ distinct combos) | ~430 lines | `pr-snapshot.ts` |
| multi-call composites stitched with `echo` separators | 67 lines | `pr-snapshot.ts` |
| CI drilldown chains (`run list` → `run view --json jobs` → `--log \| grep`, 3–5 passes per run) | 46 chains | `ci-failures.ts` |
| `gh pr diff --stat` / pathspec (flags gh doesn't have) | 34 failures | SKILL.md gotcha |
| `gh \| head` SIGPIPE false failures | ~37% of flagged gh errors | SKILL.md gotcha |

An audit of the OpenAI Codex GitHub plugin over the same corpus shaped the
philosophy. Its orienting SKILL.md was its most-used artifact; its bundled
scripts had **zero successful runs**; its ~80 connector write-tools were
never called once. The lesson: minimal prose, scripts easier than the raw
alternative, read-only surface.

## What using it gets you

- **Fewer tool calls.** PR orientation and CI drilldown were reliably 3-5
  call guessing loops in the mined sessions; each script collapses the
  chain to one.
- **Less context.** Output is bounded by design: bodies truncated with
  markers, files capped, full CI logs parked on disk with paths printed.
  A raw log dump is often 10k+ lines; the snippet that enters context is ~45.
- **Lower cost.** Fewer calls and smaller outputs mean fewer tokens per
  GitHub task, and the most expensive failure mode is gone: scripts exit 0
  when the report succeeds, so agents never burn a turn investigating a
  phantom SIGPIPE or exit-code error.
- **Faster answers.** API calls run concurrently (measured 1.5s vs 2.3s
  sequential), and killing the retry loops turns multi-turn flows into
  single turns.
- **A failure class deleted, not documented.** The most re-typed, most
  error-prone command in the corpus was a 15-line review-threads GraphQL
  query with 7 observed failure modes. It's now one short command.

## Testing

Beyond live self-testing during development, the skill went through an
adversarial three-agent verification pass:

- **Edge-case tester:** ~30 live commands against real PRs: merged, closed,
  zero-thread, 55-file, and nonexistent PRs; non-repo cwd; malformed args;
  `--json` validity piped through `jq`; green runs; workflow-level
  (startup) failures; exit-code contract on every path.
- **Adversarial code reviewer:** hunted shape assumptions vs real gh JSON,
  parseArgs strictness, pagination, error-path masking, `Promise.all`
  failure semantics, maxBuffer overflow, type-stripping compatibility.
- **Docs verifier:** executed every claim in SKILL.md against gh 2.95 and
  flagged anything wrong or version-dependent.

The pass surfaced **9 real issues, all fixed and regression-tested**, including:
`-F` coercing all-digit repo names (broke `gabrielecirulli/2048`), real gh
errors masked as "no checks reported", a silent wrong-PR path when `-R` was
combined with current-branch inference, one deleted run killing the whole
report, and a SKILL.md tip that would 404 (`-f`/`-F` silently flips GET→POST).

## Install

Requires `gh` (authenticated) and node ≥ 23.6 (scripts run TS directly).

Via the [skills CLI](https://skills.sh) (installs into whichever agents you use):

```bash
npx skills add AVGVSTVS96/better-github-skill
```

Or manually:

```bash
git clone https://github.com/AVGVSTVS96/better-github-skill ~/.agents/skills/better-github-skill
ln -s ../../.agents/skills/better-github-skill ~/.claude/skills/better-github-skill   # Claude Code
```

Scripts are plain executables; they work standalone without the skill harness:

```bash
~/.agents/skills/better-github-skill/scripts/pr-threads.ts 5017 -R owner/repo --unresolved
~/.agents/skills/better-github-skill/scripts/pr-snapshot.ts 5017 -R owner/repo
~/.agents/skills/better-github-skill/scripts/ci-failures.ts --pr 5017 -R owner/repo
~/.agents/skills/better-github-skill/scripts/pr-watch.ts 5017 -R owner/repo
```

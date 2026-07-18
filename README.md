# github: a gh CLI skill for coding agents

One `SKILL.md` + three zero-dependency TypeScript scripts that cover the GitHub
flows coding agents repeatedly fumble with raw `gh`. Everything else stays raw
`gh`; the skill is deliberately minimal: one file to read, no MCP connector,
no schema bloat, no routing ceremony.

```
SKILL.md              script index + 13 gotchas, each traced to real session failures
scripts/
  pr-threads.ts       review threads w/ isResolved/isOutdated; porcelain gh can't get this
  pr-snapshot.ts      full PR state in one call (meta, mergeability, checks, files, reviews, threads)
  ci-failures.ts      failing checks → jobs/steps → error-anchored log snippets, full logs to files
```

## Why these three (the data)

Design was mined from **1,843 real `gh` invocations** across ~7 months of
Claude Code and Codex session transcripts (~2.2 GB), extracted with paired
command→result analysis. The scripts target the highest-frequency failure and
churn classes actually observed:

| observed pattern | count | script |
|---|---|---|
| `reviewThreads` GraphQL hand-retyped from scratch (7 distinct failure modes) | 62–78× | `pr-threads.ts` |
| improvised `pr view --json` field-set guessing (40+ distinct combos) | ~430 lines | `pr-snapshot.ts` |
| multi-call composites stitched with `echo` separators | 67 lines | `pr-snapshot.ts` |
| CI drilldown chains (`run list` → `run view --json jobs` → `--log \| grep`, 3–5 passes per run) | 46 chains | `ci-failures.ts` |
| `gh pr diff --stat` / pathspec (flags gh doesn't have) | 34 failures | SKILL.md gotcha |
| `gh \| head` SIGPIPE false failures | ~37% of flagged gh errors | SKILL.md gotcha |

An audit of the OpenAI Codex GitHub plugin over the same corpus shaped the
philosophy: its orienting SKILL.md was its most-used artifact, its bundled
scripts had **zero successful runs** (no `--help`, unbounded output), and its
~80 connector write-tools were never called once. Lesson: minimal prose,
scripts that are easier than the raw alternative, read-only surface.

## What using it gets you

- **A failure class deleted, not documented.** The single most repeated,
  most error-prone command in the corpus (the 15-line review-threads GraphQL
  query) becomes one short command with pagination, `-f`/`-F` coercion, and
  author-null handling already correct.
- **1 call instead of 3–5.** PR orientation and CI drilldown were reliably
  multi-call guessing loops; each script collapses the chain and prints
  bounded, agent-readable output (bodies truncated with markers, full data
  via `--json`, big logs parked in files with paths printed).
- **No false errors.** Scripts exit 0 whenever the *report* succeeds: red CI,
  unresolved threads, and "no checks" are answers, not failures. This kills
  the observed pattern of agents misdiagnosing SIGPIPE/exit-code noise.
- **Modest latency win.** `pr-snapshot.ts` runs its three API calls via
  `Promise.all`: measured 1.5s vs 2.3s sequential on a 9-file PR. The real
  savings are the eliminated retry round-trips, not the parallelism.

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

```bash
git clone <this-repo> ~/.agents/skills/github
ln -s ../../.agents/skills/github ~/.claude/skills/github   # Claude Code
```

Scripts are plain executables; they work standalone without the skill harness:

```bash
~/.agents/skills/github/scripts/pr-threads.ts 5017 -R owner/repo --unresolved
~/.agents/skills/github/scripts/pr-snapshot.ts 5017 -R owner/repo
~/.agents/skills/github/scripts/ci-failures.ts --pr 5017 -R owner/repo
```

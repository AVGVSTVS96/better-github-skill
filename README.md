# better-github-skill: gh, optimized for coding agents

Built from an analysis of **1,843 `gh` calls across real agent sessions**,
better-github-skill reduces context window usage and returns agent-optimized
output for the GitHub workflows agents run most:

- **pr-snapshot** returns a PR's full state in one call: metadata,
  mergeability, checks, files, reviews, and thread counts as a few dozen
  dense lines, replacing the 3-5 command loop and raw JSON dumps it takes
  to assemble the same picture.
- **pr-threads** returns review threads with the resolution and outdated
  state porcelain `gh` can't surface, comment bodies truncated at the point
  of diminishing returns, filterable to just what's unresolved.
- **ci-failures** returns the failing jobs, their failed steps, and an
  error-anchored ~45-line snippet per job; full logs are written to disk
  and referenced by path, so 10k lines of CI output never enter context.

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

```bash
git clone https://github.com/AVGVSTVS96/better-github-skill ~/.agents/skills/better-github-skill
ln -s ../../.agents/skills/better-github-skill ~/.claude/skills/better-github-skill   # Claude Code
```

Scripts are plain executables; they work standalone without the skill harness:

```bash
~/.agents/skills/better-github-skill/scripts/pr-threads.ts 5017 -R owner/repo --unresolved
~/.agents/skills/better-github-skill/scripts/pr-snapshot.ts 5017 -R owner/repo
~/.agents/skills/better-github-skill/scripts/ci-failures.ts --pr 5017 -R owner/repo
```

# CSES Studio

Browse, solve, test and submit competitive-programming problems without leaving VS Code.

| Site | Browse | Local testing | Submit | Progress sync |
| --- | --- | --- | --- | --- |
| [CSES Problem Set](https://cses.fi/problemset/) | ✓ | ✓ | ✓ | ✓ (signed in) |
| [AtCoder Educational DP Contest](https://atcoder.jp/contests/dp) | ✓ | ✓ | ✓ | ✓ (username only) |

Switch with the tabs at the top of the **Problems** view. Each site keeps its own cache, progress and workspace folder.

AtCoder progress sync reads the public [AtCoder Problems](https://kenkoooo.com/atcoder) API and needs only a username; submitting needs a login.

## Features

- Problem tree with solved/attempted/unsolved status, per-category counts and an unsolved-only filter.
- Statement viewer with bundled KaTeX, so math renders offline.
- One directory per problem, seeded from a template, with samples written to `.samples/`.
- Run the samples and compare output with a coloured diff, or feed a custom input.
- Submit the current file, poll the judge, show the verdict and the first failing test.
- Practice contests: pick topics, get a timed set, watch the clock in the status bar.
- Fuzzy search over title, id and category.

## Install

There is no marketplace listing, so build the `.vsix` and install that:

```bash
npm install
npm run vsix
code --install-extension cses-studio-0.1.0.vsix
```

Or install the same file from the Extensions view: `...` menu, then **Install from VSIX…**

Needs VS Code 1.85 or newer, and `g++` on `PATH` (or point `cses.compiler.cpp` elsewhere).
Python solutions need `python3`.

## Getting started

1. Open the **CSES** view in the activity bar and run **CSES: Fetch Problems**.
2. Click a problem. The statement opens beside a generated solution file.
3. `Ctrl+Alt+T` runs the samples.
4. **CSES: Login**, then `Ctrl+Alt+S` to submit.

## Keybindings

| Command | Key |
| --- | --- |
| Run Samples | `Ctrl+Alt+T` |
| Submit | `Ctrl+Alt+S` |
| Search Problem | `Ctrl+Alt+P` |
| Mark for Revision | `Ctrl+Alt+M` |
| Start Practice Contest | `Ctrl+Alt+C` |
| Open Next Contest Problem | `Ctrl+Alt+N` |

The rest are under `CSES:` in the command palette.

## Settings

Everything lives under `cses.*`. The ones worth knowing:

| Setting | Default | |
| --- | --- | --- |
| `cses.language` | `cpp` | `cpp` or `python` |
| `cses.workspaceRoot` | workspace folder | where problem directories go |
| `cses.compiler.cppArgs` | `["-std=c++17","-O2","-Wall"]` | |
| `cses.timeLimitFactor` | `2` | multiplier on the problem's limit for local runs |
| `cses.contest.problems` / `cses.contest.minutes` | `4` / `90` | practice contest size |
| `cses.atcoder.username` | | needed for AtCoder progress sync |

Templates support `${title}`, `${id}`, `${url}`, `${category}` and `${date}`.

## On disk

```
<workspaceRoot>/
└── Introductory-Problems/
    └── 1068-Weird-Algorithm/
        ├── problem.cpp
        ├── .cses.json        # links the directory back to the problem
        └── .samples/
            ├── sample1.in
            └── sample1.out
```

Problem data is cached in `~/.cses-studio/cache/` and only refreshed when you ask. An existing solution file is never overwritten.

## Security

Credentials and session cookies go through VS Code's `SecretStorage`, backed by the OS keychain. Passwords are only kept if you choose "Stay signed in". The statement webview runs under a strict CSP with no network access, and scraped HTML is stripped of scripts and inline handlers before caching.

## Development

```bash
npm install
npm run watch     # incremental build
npm test          # unit + pipeline tests
npm run lint
npm run vsix      # package a .vsix
```

`F5` launches an Extension Development Host. The tests compile and run real C++, so `g++` must be on `PATH`.

## Notes

- Submission is written against the documented CSES flow but has not been run against a live account in this build.
- Solved status can only be read while signed in, so syncing without a session is a no-op.
- Memory usage is shown only when the judge reports it.

## License

MIT

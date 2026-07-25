# Architecture

Notes on how the extension is put together, mostly for future me.

## Layout

```
src/
├── extension.ts     activation, command registration
├── core/            config, logging, errors, DI container
├── models/          Problem, Sample, Category, Verdict, Contest, Judge
├── services/        the actual work (see below)
├── providers/       tree data providers
├── views/           webview panels, status bars
└── commands/        one module per user-facing command
```

`services/` is the bulk of it. Roughly grouped:

| Group | Files |
| --- | --- |
| HTTP | `csesClient`, `cookieJar`, `html` |
| Scraping | `scraper`, `submitter`, `atcoderScraper`, `atcoderSubmitter` |
| Auth | `auth`, `atcoderAuth`, `identity` |
| Data | `problemRepository`, `cache`, `progress`, `atcoderProblemsClient` |
| Running code | `compiler`, `runner`, `diff`, `testService` |
| Everything else | `workspace`, `contestService`, `contestPicker`, `judgeSelection`, `diagnostics` |

## Two rules worth keeping

**Only the scrapers know about HTML.** `scraper.ts` and `submitter.ts` (and their AtCoder
counterparts) are the only files that touch markup. Everything above them takes typed models.
When a site changes its layout, those are the files to fix and nothing else should need it.

**The service layer never imports `vscode`.** Config and logging come in through the
`ConfigurationProvider` and `Logger` interfaces, which is why the compile/run/compare path can be
tested with the real toolchain outside the extension host. Anything that genuinely needs the API
lives in `commands/`, `views/` or `providers/`.

## Multiple judges

`JudgeId` is `'cses' | 'atcoder-dp'`. A judge implements `ProblemSource`, and each one gets its own
client instance, its own cookie jar, its own cache namespace and its own workspace folder. The jar
never has to work out which cookies belong to which host because it only ever holds one host's.

Adding a third judge means: a `ProblemSource` implementation, a scraper, a submitter, cache keys,
and a tab in the problems view. The AtCoder support is the worked example.

## HTTP

Hand-rolled on top of `fetch` rather than a library, because two things needed custom handling:

- Redirects are followed manually so `Set-Cookie` on every hop lands in the jar. undici
  deliberately does not do this.
- Retries depend on the failure stage, not the method. A GET retries on any transient error. A POST
  only retries when the connection was never established, since replaying a submission that may
  have landed risks submitting twice.

Errors get unwrapped through `AggregateError.errors` and `cause` chains, otherwise every network
problem surfaces as an opaque "fetch failed".

The submit form is read from the live page — action URL, hidden fields, file field name, language
list — instead of being hardcoded, so a field rename on cses.fi doesn't need a release. CSES also
serves `<select name="option">` empty and fills it from script, so the compiler options are parsed
out of the page's own JavaScript; posting without one gets a 400.

## Where state lives

| What | Where | Notes |
| --- | --- | --- |
| Session cookies, passwords | `vscode.SecretStorage` | OS keychain. Password only if "stay signed in" |
| Solve status, contest state | `globalState` | Survives reloads |
| Problems and statements | `~/.cses-studio/cache/` | Atomic writes, refreshed on request only |
| Solution files and samples | The workspace | Never overwritten once created |

Nothing is written to settings, and credentials never reach the cache.

## Webviews

Statements, the browser and the test panel are webviews. They run under a strict CSP with a
per-load nonce and no network access, which is why KaTeX is vendored into `media/katex/` at build
time rather than pulled from a CDN. Scraped HTML is stripped of scripts, inline handlers and
`javascript:` URLs before it is cached, not just before it is shown.

CSP also blocks inline styles, so anything that needs a computed width sets it from the nonced
script instead of a `style` attribute.

## Tests

`node --test` against compiled output, no framework. They compile and run real C++, so `g++` has to
be on `PATH`.

Most of the tests are regression tests pinned to specific bugs — cookie loss across the login
redirect, a password leaking through AtCoder's `REVEL_FLASH` cookie, unclosed `<option>` tags
wrecking the parse tree, compiler warnings being read as errors, `/marked$/` matching `unmarked`,
and connect-stage retries. Each one names the failure it guards.

Thinner areas, in case something breaks there: the cache service, the repository worker pool,
timeout handling, the webview client scripts, and the Python path (every runtime test uses C++).

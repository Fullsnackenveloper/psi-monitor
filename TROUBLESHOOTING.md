# Troubleshooting Notes

Real issues hit while building and deploying this project, written up as postmortems. The debugging is often more instructive than the code, so these are kept as part of the record rather than buried in commit messages.

---

## The scans all failed with `RATE_LIMITED` but nothing was rate-limited

### Symptom

After deploying, the dashboard showed every site in an error state. The scanner logs were a wall of the same message:

```
✗ https://www.wikipedia.org [mobile] failed after 3 attempts: RATE_LIMITED
✗ https://www.bbc.com [mobile] failed after 3 attempts: RATE_LIMITED
...
```

Every site, every strategy, every attempt, all `RATE_LIMITED` (HTTP 429). The app's retry/backoff logic was working exactly as designed: it caught the 429s, backed off, retried, and eventually recorded the failure and moved on. Nothing crashed. But no real scores ever came back.

### First wrong guess: quota exhausted from debugging

The obvious read was that I'd simply burned the API's daily quota during development, dozens of manual scans in a short window. The plan was to stop scanning and let the quota reset overnight.

It didn't reset. The next day, every call still returned 429. A daily quota that doesn't clear after 24 hours isn't a daily quota problem.

### Second wrong guess: the API isn't enabled

Next theory: the PageSpeed Insights API wasn't enabled on the project, and Google was rejecting calls with a quota-shaped error. Reasonable, but wrong, and I was still guessing instead of reading.

### The move that actually worked: read the raw error

Instead of trusting the app's summarized `RATE_LIMITED`, I made one raw request straight to Google, bypassing the whole application, and read the complete response:

```bash
curl -s "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://example.com&strategy=mobile&key=$PSI_API_KEY"
```

The full error carried the detail the app had collapsed away:

```json
{
  "error": {
    "code": 429,
    "message": "Quota exceeded ... for consumer 'project_number:583797351490'.",
    "status": "RESOURCE_EXHAUSTED"
  }
}
```

Two facts jumped out. First, it was genuinely a *daily* quota rejection. Second — and this was the key — it named a specific **project number: `583797351490`**.

### Root cause

That project number wasn't a project I could see. My Google Cloud account only listed one project, and its number was different. The API key in the app belonged to a **different project entirely** — and no amount of fixing quotas or making new keys in *my* project would ever affect a key that routed somewhere else.

Tracing it further: the project the key belonged to was tied to a Google Cloud **free trial that had ended**. When the trial closed, its billing account closed with it, and a project with a closed billing account has its API access throttled to effectively zero — which surfaces as a 429 "quota exceeded," even though actual usage was `0`.

So the real chain was:

```
free trial ended
  → billing account closed
    → project's API access throttled to ~0
      → every PSI call rejected as 429 "quota exceeded"
```

Three layers away from anything in the application. The code was correct the entire time.

### The fix

1. Reactivated billing on the project I controlled (a standard pay-as-you-go account; PageSpeed Insights stays free within its daily quota).
2. Created a fresh API key **in that project** | verifying the project name on the key-creation screen, since keys silently attach to whatever project is selected.
3. Corrected the environment file. (A separate, smaller bug had crept in here — see below.)
4. Re-ran the raw `curl` and got a real `lighthouseResult` back instead of a 429.

### A smaller bug hiding inside the big one

While swapping keys, the env file ended up with the bare key value on the first line instead of `PSI_API_KEY=<value>`. Sourcing it made the shell try to *execute* the key as a command:

```
AIzaSy...: command not found
```

Easy to miss under the noise of the larger problem. The habit that catches it: after writing any secrets file, `cat` it back and read line one with your own eyes before trusting it.

### Lessons

- **When an API reports "quota exceeded" but usage reads zero, suspect billing or account state before code.** A closed or unverified billing account throttles APIs and reports it as a quota error.
- **Read the raw error, not the summarized one.** The application had helpfully collapsed the failure to `RATE_LIMITED` and discarded the `project_number`, the single most important clue. One direct `curl` exposed it.
- **API keys belong to a project, and the project is easy to get wrong.** The identifier in an error message tells you which project a request actually billed against; trust that over which project you *think* the key is from.
- **Fix one variable at a time.** Waiting for a reset, then toggling an API, then swapping keys, each was a guess. The turnaround came from stopping the guessing and reading ground truth.
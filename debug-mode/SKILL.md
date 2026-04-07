---
name: debug-mode
description: Interactive debugging mode that generates hypotheses, instruments code with runtime logs, and iteratively fixes bugs with human-in-the-loop verification. Works for backend, browser frontend, and native iOS/Android apps via a localhost HTTP ingest. Only for hard-to-diagnose bugs; in those cases, remind the user that debug-mode is available, and never proactively activate this skill.
---

# Debug Mode

You are in **Debug Mode** — a hypothesis-driven debugging workflow. Do NOT jump to fixes. Follow each phase in order.

---

## Phase 1: Understand the Bug

Ask the user (if not already provided): expected vs actual behavior, reproduction steps, error messages, **and target environment** (server / browser / iOS sim / iOS device / Android emulator / Android device).

Read the relevant source code. Understand the call chain and data flow.

## Phase 2: Generate Hypotheses

Generate **testable hypotheses** as a numbered list:

```
Based on my analysis, here are my hypotheses:

1. **[Title]** — [What might be wrong and why]
2. **[Title]** — [Explanation]
3. **[Title]** — [Explanation]
```

Include both obvious and non-obvious causes (race conditions, off-by-one, stale closures, type coercion, threading, lifecycle, etc.). On mobile, **front-load 4–5 hypotheses per pass** — each instrumentation cycle costs a rebuild.

## Phase 3: Instrument the Code

### Log file

All logs land in **a per-session timestamped file** under `{project_root}/.claude/`, e.g. `{project_root}/.claude/debug-20260407-153045.log` (absolute path). This lets the user run multiple parallel debug sessions without collisions.

**At the start of every debug session, pick a timestamp once** (format `YYYYMMDD-HHMMSS`) and reuse the same path for the rest of the session. Treat it as a hardcoded constant string in any instrumentation you write. PROHIBITED: `import.meta.dir`, `__dirname`, `process.cwd()`, `Deno.cwd()`, `path.resolve()`, `Bundle.main`, runtime time formatting, etc. Exception: remote/CI environments or non-writable local filesystem — use `/tmp/.claude/debug-<timestamp>.log` instead.

If you are using the bundled ingest server (browser/mobile flows — see "Starting the ingest server" below), **you start it yourself**; it picks the timestamped filename and writes the path to its startup output. Capture that path and use it for the rest of the session. The ingest server also maintains `.claude/debug.log` as a symlink to the newest session for convenience, but **always reference the timestamped file by name** in your reads so parallel sessions stay isolated.

Before each reproduction *within the same session*: **truncate** that session's log file (do not delete and recreate — keep tail-followers attached).

### Transports — pick the right one for the environment

| Environment | Transport |
|---|---|
| **Server-side (Node, Python, Go, …)** | File-append (`fs.appendFileSync`, `open("a")`, etc.) |
| **Browser** | `fetch('http://127.0.0.1:8792/ingest', { method: 'POST', body: JSON.stringify({...}) })` |
| **iOS simulator** | `os_log` with `%{public}@` format specifier — captured via `xcrun simctl spawn booted log stream` (see below) |
| **iOS device** | `URLSession` POST to `http://<mac-lan-ip>:8792/ingest`. Add an ATS exception for the LAN host in `Info.plist` for the debug build only. |
| **Android emulator** | `OkHttp` / `HttpURLConnection` POST to `http://10.0.2.2:8792/ingest` (the emulator's host loopback alias) |
| **Android device** | POST to `http://<mac-lan-ip>:8792/ingest`. Add `usesCleartextTraffic="true"` in the debug manifest only. |

**Starting the ingest server (you do this, not the user).** Before instrumenting any browser or mobile code, spawn the ingest server in the background. The script lives next to this `SKILL.md` at `../scripts/ingest_server.js` relative to the skill file — resolve that path from your tool's view of the skill directory.

Run it as a backgrounded subprocess from the project root:

```bash
# Browser, iOS simulator, Android emulator → localhost is enough
node <skill_dir>/scripts/ingest_server.js &

# Physical iOS / Android device on the same LAN
HOST=0.0.0.0 node <skill_dir>/scripts/ingest_server.js &
```

Then **read the server's startup output** (first 2 lines) to learn:

1. The actual bound port (the server may have walked past `8792` if it was in use):
   `[debug-mode] ingest listening on http://127.0.0.1:<PORT>`
2. The session log file path:
   `[debug-mode] writing to /abs/path/.claude/debug-<timestamp>-<pid>.log`

**Hardcode that exact port and log path** into the rest of the session — into your instrumentation, into your log-reads, into your cleanup. Do NOT assume `8792`. Do NOT compute the path at runtime.

Record the server's PID so you can stop it in Phase 6.

The server appends each POST as one NDJSON line to the session log file. It accepts JSON bodies (preferred) or plain text. It auto-creates `.claude/` if needed.

**Fallback for Android without network:** instead of HTTP, instrument with `Log.d("DEBUG_H1", ...)` and have the user run `adb logcat -s DEBUG_H1 DEBUG_H2 DEBUG_H3 > .claude/debug.log` in a side terminal. Tags map directly to hypotheses.

**Fallback for iOS simulator without network:** use `os_log(.debug, "[DEBUG H1] %{public}@", value)` and have the user run:
```bash
xcrun simctl spawn booted log stream --predicate 'eventMessage CONTAINS "[DEBUG H"' > .claude/debug.log
```

### Region markers

ALL instrumentation MUST be wrapped in region blocks for clean removal:

```
// #region DEBUG       (JS/TS/Java/C#/Go/Rust/C/C++/Swift/Kotlin)
# #region DEBUG        (Python/Ruby/Shell/YAML)
<!-- #region DEBUG --> (HTML/Vue/Svelte)
-- #region DEBUG       (Lua)

...instrumentation...

// #endregion DEBUG    (matching closer)
```

Swift and Kotlin both treat `// #region DEBUG` as plain comments — the marker still allows reliable grep-based cleanup. For Info.plist ATS exceptions or AndroidManifest cleartext flags added during debugging, wrap them in XML comment markers `<!-- #region DEBUG -->` and remove during cleanup.

### Logging rules

- **Never write debug output to a destination that ships in release builds without going through `.claude/debug.log`.** On server/web that means no `console.log`/`print`. On mobile, platform-native logging APIs (`os_log`, `Log.d`) are acceptable **only** when paired with a capture command (`log stream`, `logcat`) that funnels into `.claude/debug.log`. HTTP ingest is preferred when feasible because it unifies the pipeline.
- Log messages include hypothesis number: `[DEBUG H1]`, `[DEBUG H2]`, etc. For HTTP ingest, send `{ "h": "H1", "msg": "...", "vars": {...} }`.
- Log variable states, execution paths, timing, decision points, **thread/queue names on mobile**.
- Be minimal — only what's needed to confirm/rule out each hypothesis.

After instrumenting, tell the user to (rebuild if mobile, then) reproduce the bug, then **STOP and wait**.

## Phase 4: Analyze Logs & Diagnose

When the user has reproduced:

1. **Check log file size first** (`wc -l` or `ls -lh`). If large, use `tail` or `grep "\\[DEBUG H\\|\"h\":\"H"` to extract relevant lines instead of reading the whole file.
2. Map logs to hypotheses — determine which are **confirmed** vs **ruled out**.
3. Present diagnosis with evidence:

```
## Diagnosis

**Root cause**: [Explanation backed by log evidence]

Evidence:
- [H1] Ruled out — [why]
- [H2] Confirmed — [log evidence]
```

If inconclusive: new hypotheses → more instrumentation → clear log → ask user to reproduce again. On mobile, remind them this means another rebuild.

## Phase 5: Generate a Fix

Write a fix. Keep debug instrumentation in place.

Clear `.claude/debug.log`, ask user to verify the fix works, then **STOP and wait**.

## Phase 6: Verify & Clean Up

**If fixed:** Clean up in this order:

1. Remove all `#region DEBUG` blocks and contents (use Grep across all extensions, including `.swift`, `.kt`, `.kts`, `.plist`, `.xml`).
2. Revert any debug-only ATS exceptions / cleartext flags wrapped in XML region markers.
3. **Stop the ingest server** if you started one — `kill <recorded_pid>` (or `kill %1` if it was the only background job you spawned). Verify it's gone with `ps -p <pid>` returning nothing. Never leave the server running after the session.
4. Delete this session's `.claude/debug-<timestamp>-<pid>.log` (leave other parallel sessions' files alone). Leave the `.claude/debug.log` symlink alone — the server cleans it up implicitly on next use.
5. Summarize the root cause, the fix, and confirm cleanup is complete.

**If NOT fixed:** Read new logs, ask what they observed, return to **Phase 2**, iterate.

---

## Rules

- **Never skip phases.** Instrument and verify even if you think you know the answer.
- **Never remove instrumentation before user confirms the fix.**
- **Never write debug output to a destination that survives into release builds** without going through `.claude/debug.log`.
- **Always clear the log before each reproduction.**
- **Always wrap instrumentation in `#region DEBUG` blocks.**
- **Always wait for the user** after asking them to reproduce.
- **On mobile, batch hypotheses aggressively** to minimize rebuild cycles.
- **You own the ingest server's lifecycle.** If you started it, you must stop it before declaring the session done. Never ask the user to start or stop it.

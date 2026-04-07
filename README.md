# debug-mode

A hypothesis-driven debugging skill for coding agents (Claude Code, Codex, Gemini CLI, and any agent that supports the [skills](https://code.claude.com/docs/en/skills) format). Works across backend, browser, and native mobile apps. The agent generates testable hypotheses, instruments your code with targeted logs, has you reproduce the bug, then diagnoses and fixes from real evidence — never blind guessing.

Features:

- **Hypothesis-driven workflow** with human-in-the-loop verification at each phase.
- **HTTP ingest server** (`scripts/ingest_server.js`) for browser and mobile log delivery — zero dependencies, pure Node. Auto-falls-back across ports, timestamped per-session log files, optional LAN binding for physical devices.
- **Cross-platform transports**: server file-append, browser `fetch`, iOS simulator (`os_log` + `simctl log stream`), iOS device (URLSession + LAN ingest), Android emulator (`10.0.2.2:8792`), Android device (`adb logcat` fallback or LAN ingest).
- **Region-marker cleanup** for JS/TS, Python, Go, Rust, Java, C#, Swift, Kotlin, Lua, HTML/Vue/Svelte — instrumentation is fully removable in one pass once the bug is fixed.
- **Parallel sessions** via timestamped+PID log filenames.

## Install

Symlink (or copy) the `debug-mode/` directory into your agent's skills folder:

```bash
# Claude Code
ln -s "$PWD/debug-mode" ~/.claude/skills/debug-mode

# Codex
ln -s "$PWD/debug-mode" ~/.codex/skills/debug-mode

# Gemini CLI
ln -s "$PWD/debug-mode" ~/.gemini/skills/debug-mode
```

(Create the parent `skills/` directory first if it doesn't exist.)

## Run the ingest server

```bash
# Localhost only — for browser and iOS simulator / Android emulator
node scripts/ingest_server.js

# LAN-exposed — required for physical iOS / Android devices
HOST=0.0.0.0 node scripts/ingest_server.js

# Custom log file / port
PORT=9000 LOG_FILE=./.claude/debug.log node scripts/ingest_server.js
```

The server appends every POST to `/ingest` (or `/`) as one NDJSON line. JSON bodies are merged with a `ts` field; non-JSON bodies become `{ "message": "..." }`.

### Quick smoke test

```bash
node scripts/ingest_server.js &
curl -s -X POST http://127.0.0.1:8792/ingest \
  -H 'Content-Type: application/json' \
  -d '{"h":"H1","msg":"hello","vars":{"x":1}}'
cat .claude/debug.log
```

## Transports cheat sheet

| Environment | Endpoint |
|---|---|
| Browser | `http://127.0.0.1:8792/ingest` |
| iOS simulator | `http://127.0.0.1:8792/ingest` (or `os_log` + `simctl log stream`) |
| iOS device | `http://<mac-lan-ip>:8792/ingest` (HOST=0.0.0.0, ATS exception) |
| Android emulator | `http://10.0.2.2:8792/ingest` |
| Android device | `http://<mac-lan-ip>:8792/ingest` (HOST=0.0.0.0, cleartext flag) |

## Usage

In your agent, just describe a hard-to-diagnose bug, or invoke explicitly:

```
/debug-mode the iOS app freezes after the second pull-to-refresh
```

The agent will follow the structured loop in [`debug-mode/SKILL.md`](debug-mode/SKILL.md).

## Credits

Inspired by [Cursor's Debug Mode](https://cursor.com/blog/debug-mode), and by two earlier ports of the idea to coding agents:

- [doraemonkeys/claude-code-debug-mode](https://github.com/doraemonkeys/claude-code-debug-mode) — the hypothesis-driven workflow and `#region DEBUG` cleanup convention.
- [laiso/claude-code-dmd](https://github.com/laiso/claude-code-dmd) — the idea of a localhost HTTP ingest for runtime log collection.

This project takes those ideas and extends them with mobile transports, parallel sessions, and a zero-dependency Node ingest server.

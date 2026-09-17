# dsh-memory

English | [中文](README.zh.md)

**Layered, auto-injected cross-session memory for AI coding agents.**
A [DSH](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek Harness) plugin, plus a
zero-dependency standalone CLI. It borrows the *spec / change / archive* discipline from
[OpenSpec](https://github.com/Fission-AI/OpenSpec) — but **pushes** instead of pulls.

> Status: **M1–M3 done and verified inside a real DSH session** (differential injection, both tools,
> the distillation nudge). See [Verification](#verification).

## Why

AI coding assistants have two recurring problems:

1. **A new session remembers nothing.** You re-explain the background, your preferences, and every
   conclusion you already reached.
2. **What does get remembered is unmanaged.** Everything piles into one or two Markdown files that grow
   without bound, cost more every session, and — worst of all — **stale conclusions are never removed.**

Existing spec-driven tools (OpenSpec and friends) solve "the code drifts away from the plan". But they
are **pull-based**: the agent has to be told to go read the specs, so a fresh session does not
spontaneously remember anything. dsh-memory is **push-based**: at session start the agent is handed what
it should know — but only the *distilled* part, and only *what changed*. Details stay retrievable on demand.

## Design

```
        ┌─ PUSH: injected automatically at session start (hard byte budget)
        │    T0 identity & conventions   user preferences / machine facts / accounts
        │    T1 index & next actions     what to pick up
store ──┤
        └─ PULL: retrieved on demand (costs nothing by default)
             inbox/      candidate entries — **the only layer the model may write**
             facts/      current truth (only status=active is injected)
             decisions/  choices plus their reasons (append-only)
             archive/    superseded entries
             journal.md  activity log (never injected)
```

Seven rules:

- **The pushed part must be tiny.** Everything in the injected layer is paid for on every session, so the
  journal and design docs stay out of it.
- **Only the delta is pushed.** Every entry carries a 12-char content hash; the plugin remembers the
  previous round's state and next round pushes only *added / updated / removed*. When nothing changed it
  injects **nothing at all**. (The upstream `dsh-agent-instructions` plugin has no diffing: any file
  change re-injects the whole file — measured at ~58k wasted tokens for 15 edits of one 8.5 KB file.)
- **State is recovered from the conversation itself.** No side-car state file: the plugin reads back the
  `{id: hash}` map from the message it previously injected, so session resume, replay and compaction all
  stay correct.
- **The model may only write to the inbox.** A wrong conclusion that silently reaches the standing layer
  gets **re-injected forever**. Promotion is an explicit `promote`.
- **One key, one truth.** Facts and decisions carry a semantic `key`, and only one *active* entry may
  exist per `scope+key`. A new conclusion must explicitly `--supersedes` the old one — that gate is what
  keeps memory rot out of the injected layer.
- **Entries have state**: `active` / `superseded` / `expired`. Superseded entries get bidirectional links
  and are archived, never appended forever.
- **Plain Markdown + frontmatter**: human-readable, diffable, reviewable, committable like code.

## Install (as a DSH plugin)

⚠️ This section is the result of real trial and error — both wrong turns below are silent failures:

```text
❌ Adding the package to package.json's dsh.profile.bundles
   → DSH regenerates that list from the market registry (.generations/desired.json) at boot;
     entries it does not know about are dropped.

❌ Writing a bare entry in cordis.patch.yml
   → silently ignored (a patch entry only targets an existing id for config/disable).

✅ Wrapping it in `- insert:` inside cordis.patch.yml
```

**Steps** (`DSH_HOME` is usually `%APPDATA%\dsh-desktop\harness`):

1. Copy this package into the profile's `node_modules`:

   ```
   <DSH_HOME>\profiles\web\node_modules\dsh-memory\
       package.json
       bin\mem.mjs
       src\plugin.mjs  src\hook.mjs  src\planner.mjs
   ```

2. Append to `<DSH_HOME>\profiles\web\cordis.patch.yml`:

   ```yaml
   - insert:
       - id: dsh-memory
         name: dsh-memory
         config:
           root: ''          # empty = <session cwd>/memory
           maxBytes: 3072    # byte budget for the baseline injection
           enabled: true
   ```

3. Save. The patch layer is watched (`watchUserPatches`) — it **hot-reloads, no restart needed**.

**Uninstall**: remove that `- insert:` block and delete `node_modules\dsh-memory`.

> The market/registry publishing flow was not investigated yet; the above is the local install path.

### What the plugin provides

| Capability | Detail |
| --- | --- |
| **Differential injection** | First round injects every active entry (baseline); afterwards only *added / updated / removed*; **nothing at all** when unchanged |
| `memory_search` | Search facts / decisions / inbox / archive / journal |
| `memory_write` | Record a candidate into the inbox — **the model cannot touch the standing layer** |
| Distillation nudge | Once a session has run a few steps and memory is already current, it reminds the model to record conclusions with `memory_write`; one nudge per session, and the nudge message carries **no state**, so it cannot corrupt the diff baseline |

The plugin never spawns the CLI: the DSH sandbox forbids named pipes (capturing a child's output fails
with EPERM), and there is no need — it imports the same store module directly (`bin/mem.mjs` only runs
the CLI when executed as the entry point).

## CLI usage

```bash
# init (defaults to <cwd>/memory; override with --root or $DSH_MEMORY_ROOT)
mem init --root ./memory --scope "workspace:/path/to/project"

# record a candidate (lands in inbox, never injected)
#   --id  prefer an explicit short id; otherwise derived from the conclusion (capped at 20 chars)
#   --key semantic key: only one active truth per scope+key
mem new --type fact --id win-update-cache --key disk-cleanup \
        --conclusion "Cleaning the update cache reclaimed nothing measurable" \
        --reason "Directory emptied but free space did not move" --tags windows,disk --source session-abc

# promote it once confirmed; when the key already has an active entry you must say who supersedes whom
mem promote win-update-cache
mem promote win-update-cache-v2 --supersedes win-update-cache

mem set <id> --key k --tags a,b --conclusion "…"   # edit an entry (add a key, reword, mark expired)
mem list --status active --tag windows
mem show <id>
mem validate [--fix]   # format / ids / bidirectional links / cycles / same-key conflicts / index / budget
mem index              # rebuild index.md
mem inject [--json] [--budget 3072]   # render what should be injected; --json adds per-entry hashes
mem recall <keyword>
mem journal add "one line"
```

## Verification

Checked item by item inside a real DSH session:

| Capability | Live evidence |
| --- | --- |
| baseline injection | the session received every active entry |
| no change → zero injection | the next step injected nothing, only the one-time nudge |
| delta · added | "新增：<new entry>", explicitly noting "the other N entries are unchanged" |
| delta · updated | after editing one entry, only "已更新：<that entry>" was pushed |
| `memory_search` / `memory_write` | both called successfully in the real runtime |
| writes land only in the inbox | the written candidate did **not** enter the injection payload; it appeared as a delta only after promotion |

## Development

```bash
npm test        # 173 assertions
```

| Suite | Assertions | Covers |
| --- | --- | --- |
| `test/run-tests.mjs` | 62 | CLI end-to-end (incl. a non-ASCII path regression) |
| `test/planner-tests.mjs` | 36 | the diff algorithm (pure logic) |
| `test/hook-tests.mjs` | 39 | plugin wiring (fake agent / decision) |
| `test/plugin-tests.mjs` | 36 | plugin integration (stubbed DSH modules, real `apply()`) |

`test/plugin-tests.mjs` replaces the four `@deepseek-ai/*` packages with the stubs in `test/stubs/`
(via `test/stub-loader.mjs`) and **actually `apply()`s the plugin**, so its behaviour is verifiable
without a DSH installation. `test/preflight-import.mjs` goes one step further: run it from inside a
profile and it exercises the **real** `@deepseek-ai/*` modules (does the real `defineTool` accept our
tool definitions, does the real `schemastery` accept our config schema).

Regression tests baked in from real bugs:

- With a **non-ASCII** path, Node's `fs.rmSync` fails **silently** (and can crash the process with
  `recursive`) — `unlinkSync` must be used instead;
- The DSH sandbox forbids named pipes, so `spawnSync` with the default `stdio: 'pipe'` hits EPERM —
  tests must redirect child output to a **file**;
- An entry written by the tool must carry the **session workspace** scope, not the harness process cwd.

## Roadmap

- **M1 ✅** CLI + structured entries + validate + index/injection budget
- **M2 ✅** explicit short ids, semantic keys and "one key one truth", `inject --json` diff payload,
  `validate --fix`, `mem set`
- **M3 ✅** DSH plugin: differential injection + both tools + the distillation nudge (verified live)
- **M4** publish (GitHub primary / Gitee mirror)

## License

MIT

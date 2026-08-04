# scripts/ - dev tooling

## setup-output-demo.mjs

Zero-dependency standalone preview of the `sf veles setup` staged CLI output: an
icon-first cyan spinner on a grey running-line, replaced in place by a done-line
(green check + dim elapsed time) as each step completes, or a red cross on failure.
It exists to iterate on the CLI visuals fast, with no real command run and no
Salesforce wiring. The `StepRenderer` here is the same rendering logic that is (or
will be) ported into the real plugin renderer in `src/commands/veles/setup.ts`, so
previewing here faithfully reflects the shipped look.

### Dev-only, not shipped

This is a repo dev/test tool, not part of the published plugin. It is excluded from
the npm tarball by the `files` whitelist in `package.json` (`["lib", "messages",
"oclif.manifest.json"]`), it is not compiled into `lib`, and it is not an oclif
command. It never runs at plugin runtime.

### Run

Needs a real TTY to see the animation; piped/CI output shows final lines only.

```
node plugin/scripts/setup-output-demo.mjs
node plugin/scripts/setup-output-demo.mjs --delay 500
node plugin/scripts/setup-output-demo.mjs --fail-at 5
npm run demo:output --prefix plugin
```

### Flags

| Flag            | Effect                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--delay <ms>`  | Fake per-step delay. Default 2000.                                                                                             |
| `--fail-at <n>` | Make step `n` (1-based) fail with a red cross and stop.                                                                        |
| `--long-status` | Spin the last step with a long status so you can shrink the terminal and confirm the line truncates to one row (no wrap-spam). |

### Extend / keep in sync

To add, rename, or reorder steps, edit the `STAGES` array at the top of the script.
To preview a failure, use `--fail-at <n>`. Maintenance contract: when the real
plugin's step list or renderer look changes, update this demo to match so it stays a
faithful preview.

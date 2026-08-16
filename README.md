# Pi Thinking Memory

**Remember a separate thinking level for every Pi model.**

`pi-thinking-memory` is a global [Pi coding agent](https://github.com/earendil-works/pi-mono) extension. It associates the effective thinking level with an exact provider/model pair and restores that level when you switch back.

For example:

1. select `gpt-5.6-sol` and choose `medium`;
2. switch to `gpt-5.6-luna` and choose `high`;
3. switch back to `gpt-5.6-sol` — Pi returns to `medium`;
4. switch to `gpt-5.6-luna` — Pi returns to `high`.

The preferences survive project changes, session changes, reloads, Pi restarts, and package upgrades.

## Behavior

- Preferences are keyed by both provider and model ID. `openai/model` and `proxy/model` are independent.
- Changing Pi's thinking level records the effective value for the active model.
- Switching normally with `/model` or model cycling restores a saved value.
- An unseen model keeps Pi's inherited and capability-clamped result. The extension does not impose a default.
- Pi remains authoritative about model capabilities. If a saved level is no longer supported, Pi clamps it and the extension updates the saved value.
- Explicit Pi configuration wins:
  - startup and restored-session levels are not replaced;
  - a scoped model entry that pins a thinking level is not replaced.
- A manual thinking-level change made while a scoped pin is active is still remembered, but the pin continues to win whenever that scoped model is selected.

The extension has no commands, tools, status items, or normal-operation notifications.

## Requirements

- Pi `0.84.2` or newer
- Node.js `22.6` or newer for development and tests

## Install

### npm

```bash
pi install npm:@janvitos/pi-thinking-memory
```

### GitHub

```bash
pi install git:github.com/janvitos/pi-thinking-memory
```

### Local development

```bash
git clone https://github.com/janvitos/pi-thinking-memory.git ~/src/pi-thinking-memory
pi install ~/src/pi-thinking-memory
```

For a one-off test without installing it:

```bash
pi -e ~/src/pi-thinking-memory/index.ts
```

Start a new Pi process after installation, or use `/reload` in an existing session.

## Persistence

Preferences are stored globally at:

```text
~/.pi/agent/pi-thinking-memory.json
```

The actual agent directory comes from Pi, so rebranded distributions can use their configured location. The file uses a versioned JSON format and private file permissions.

Updates are serialized, protected with an inter-process lock, merged with the latest on-disk state, and committed with an atomic rename. Lock contention is retried beyond the stale-lock window, preventing normally operating Pi processes from overwriting one another's model preferences.

Pi's `thinking_level_select` notification does not include a model identity and is emitted asynchronously. In the unusual case that another extension delays that notification while the user immediately switches models or exits, Pi does not expose enough information to attribute the delayed change reliably; that final rapid change may not be saved.

A missing file is treated as empty. Invalid current-version entries are logged to stderr, ignored, and repaired by the next update while valid entries are retained. An unknown newer schema version is left untouched rather than downgraded. Storage failures are logged with a `[pi-thinking-memory]` prefix and do not stop Pi.

## Development

```bash
npm install
npm test
npm pack --dry-run
```

The tests cover schema validation, global storage, concurrent updates, explicit-setting precedence, unseen models, exact model identities, clamping, delayed thinking events, and rapid model switches.

## Publishing

Releases use npm Trusted Publishing from `.github/workflows/publish.yml`; no long-lived `NPM_TOKEN` GitHub secret is required. Configure the npm package's **Trusted Publisher** with these exact values:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| GitHub owner | `janvitos` |
| Repository | `pi-thinking-memory` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |

The workflow requests GitHub's OIDC `id-token: write` permission and runs in the protected `npm` environment. You can optionally add deployment reviewers or tag protection to that environment in the GitHub repository settings; do not add an npm token to it.

For each future release, bump both `package.json` and `package-lock.json`, commit and push the change, then push a matching semantic-version tag:

```bash
npm version patch
# or: npm version minor / npm version major
git push origin main --follow-tags
```

The workflow serializes releases, installs from `package-lock.json`, verifies that the tag equals `v<package.json version>`, runs the `prepublishOnly` type-check and tests, and publishes publicly with npm provenance. Version `0.1.0` was published manually; do not recreate its tag because npm versions are immutable.

## License

[MIT](LICENSE)

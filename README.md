# dsh-subscriptions

Use your own **Claude** and **ChatGPT/Codex** subscriptions as model providers in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the same OAuth sign-in the Claude Code and Codex CLIs use. No API key.

## Install

```bash
dsh plugin --profile web add github:DevViking-Persike/dsh-subscriptions
```

Restart `dsh`, then sign in to whichever subscription you have:

```
http://127.0.0.1:1458/claude/start
http://127.0.0.1:1458/codex/start
```

Each opens the vendor's own sign-in page and stores the resulting OAuth credential locally. Tokens refresh on their own; you sign in once.

| Route | Provider | Credential |
|---|---|---|
| `claude` | `claude-code-oauth` | `~/.dsh/claude-code-oauth.json` |
| `codex` | `codex-oauth` | `~/.dsh/codex-oauth.json` |

Other endpoints: `GET /<route>/status` reports whether a subscription is connected and when its token expires; `POST /<route>/logout` removes the credential. The server binds to loopback only.

## Configuration

Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `routes` | `['claude', 'codex']` | Which subscriptions to mount. |
| `controlPort` | `1458` | Loopback port for the sign-in endpoints. |
| `claudeModels` / `codexModels` | shipped catalogs | A supplied array **replaces** the default. |
| `claudeCredentialPath` / `codexCredentialPath` | under `~/.dsh` | Where each credential is stored. |
| `claudeImportFrom` / `codexImportFrom` | — | Seed once from a CLIProxyAPI auth file. |
| `streamIdleTimeoutMs` | `300000` | Budget between reads before the transport gives up. |
| `defaultContextWindow` | `200000` | Context assumed for a model absent from the catalog. |
| `maxTokens` | `32000` | Output cap when neither request nor catalog states one. |
| `retryPolicy` | normal, 3 retries | Merged over the default. |

```yaml
- id: dsh-subscriptions
  name: 'dsh-subscriptions'
  config:
    routes: ['claude']
    controlPort: 1458
```

## Model Experience

The shipped catalogs include GPT-6 Astra (`gpt-6-astra`) and Claude Fable 5.1 (`claude-fable-5-1`), with text and image input. Availability still depends on the subscription. Both expose Low, Medium, High, Xhigh, and Ultra Code (`max`) in the Harness effort selector. Other known models expose their supported levels; unknown models and Haiku do not advertise a selector. Omitting effort preserves the provider default.

Claude sends the selected value through `output_config.effort`; Codex uses `reasoning.effort`. Ultra Code is a display label, not an `ultracode` API value. Unsupported declared choices fail before credential access or provider I/O. Capabilities follow the [Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra) and [Claude effort reference](https://platform.claude.com/docs/en/build-with-claude/effort). Changing top-level effort can affect prompt-cache reuse.

Transparent to the model: the plugin registers provider routes and streams responses, adding no tool, prompt section, or context.

What it affects is accounting, and the two routes deliberately **disagree**:

- **Claude** reports `input_tokens` already excluding cache reads, so nothing is subtracted.
- **Codex** includes them, so they are subtracted to keep the counts disjoint.

Both directions are pinned by tests recorded from the harness's own implementations, because getting either backwards raises nothing — it just misreports context in every cost display.

Text and image input on both routes. An image block is a durable attachment reference, not bytes: the adapter resolves it through the harness attachment service per request (so mounting that service later starts image input without a restart) and sends it inline — a base64 `image` source on the Anthropic route, a `data:` URL `input_image` on the Responses route. A model whose catalog entry does not declare image input is refused before serialization, since dropping the image silently would have the model answer a question it never saw. Tool-result images ride inside the `tool_result` content array on the Claude route; the Codex route's `function_call_output` takes a string only, so its images are flushed into a following user message in order.

## Safety

- Credentials are written atomically with owner-only permissions (`0600`, parent `0700`), and the file is read through a **cross-process writer lock**. Two DSH instances refreshing at once cannot corrupt the document or burn the refresh token twice — proven by a test that forks real processes, with a negative control that fails when the lock is removed.
- A token never appears in an error message, a log line, or the `/status` response. Upstream error bodies are redacted before being quoted.
- A failed refresh leaves the stored credential untouched, so a transient outage cannot force a re-login.
- A truncated stream raises `STREAM_CLOSED` rather than presenting as a finished response.
- A stale lock is never stolen: file age cannot prove its owner died, so orphan recovery stays an operator action.

## Known Limitations and Deferred Work

- **Version-sensitive by construction.** This plugin lives outside the harness repository, which states it makes no compatibility promise before its first release. The chunk vocabulary is therefore verified at load, and a mismatch refuses to mount with a message naming the drifted field.
- The sign-in callback binds `127.0.0.1`, while the vendors' registered redirect URIs say `localhost`. On a host where `localhost` resolves to `::1` first, the browser callback will not arrive. The ports are fixed by the public clients and cannot be reconfigured.
- Model catalogs are static configuration, not discovered from the vendor. A model your subscription serves but the catalog omits still works when named explicitly, resolving with the default context window.
- Image input requires the harness attachment service (`ctx.attachments`); without it, an image request is refused with `UNSUPPORTED_CONTENT` rather than dropped. The Codex route rejects stop sequences — the Responses API has no equivalent, and silently dropping one would let a model run past a boundary the caller relied on.
- The test suite runs entirely against local `node:http` servers. It proves this plugin's behavior, not that either vendor still speaks exactly this dialect: the fixtures encode the harness's belief about the wire, recorded from its own implementations.

## Tests

Both adapters implement the Harness `prepareCall()` protocol: preparation binds model metadata and dispatch to the same adapter configuration without reading credentials or contacting the provider. Image request pricing is unspecified, so the Harness uses its neutral estimate. Adapter transport tests dispatch through prepared calls.

```bash
npm install && node --test test/*.test.js
```

No vendor network access or credentials are required; adapter tests bind temporary loopback ports.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). Using this plugin means using your own subscription under its own terms.

# Third-party notices

## DeepSeek Harness

This plugin targets [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT).
Its `packages/llm/llm-claude-code` and `packages/llm/llm-codex` are the
reference this port was verified against: the translator and serializer test
fixtures are recorded output from those implementations, so a divergence fails
the suite rather than reaching a model call. The cross-process writer lock is
ported from that project's `packages/util/atomic-write`.

This plugin imports no harness package; every capability is reached through
`ctx` at run time.

## Anthropic and OpenAI

Targets the public OAuth clients that Claude Code and the Codex CLI use, and
the endpoints those products call. No code from either product is included.
Using this plugin means using your own subscription under its own terms.

## eventsource-parser

Server-sent-event framing is [`eventsource-parser`](https://github.com/rexxars/eventsource-parser)
(MIT), installed as an ordinary npm dependency.

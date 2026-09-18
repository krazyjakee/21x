# Chat runtime

A small main-process loop for fast, conversational models. It is the base for
the Commander (issue #68): a cheap live-chat model with delegation-only tools.
It is deliberately not an agent: no workspace, no process per turn, no
polling. Nothing here goes through the coding-agent adapters.

Code lives in `src/main/chat/`; IPC in `src/main/ipc/chat.ts`; shared wire
types in `src/shared/chat.ts`.

## The loop

`ChatRuntime.startTurn({ provider, messages, system, tools, maxToolCalls })`
runs one turn:

1. Stream a model call. Text arrives as `text_delta` events as it is generated.
2. If the model asked for tools, run each one (`tool_call_start`,
   `tool_call_result`), append the results, and go to 1.
3. Stop when the model answers in text, the per-turn tool-call limit is hit,
   the turn is cancelled, or something fails. Always ends with `done`.

The handle returned has `turnId`, `cancel()` and `done` (a promise that
resolves with the final history and usage; it never rejects). Events are
never emitted synchronously from `startTurn`.

Tool-call limit: default 8 per turn, hard cap 32. Once reached, extra calls
get an error result and the model is asked once more with `toolChoice: 'none'`
so it answers in text. A `max_tokens` stop with a pending tool call never runs
the tool; a truncated input looks valid.

Cancellation: every turn has its own `AbortController`. The signal reaches the
provider (which aborts the HTTP request) and every tool handler. Partial text
is kept in the returned history.

## Tools

`ChatToolDefinition` (`src/main/chat/tools.ts`): `name`, `description`, a JSON
schema with an object root, and an async `handler(input, { signal, toolCallId })`
returning a string or `{ content, isError }`. A thrown error becomes an
`isError` result the model can read. What a model can do is enforced by the
tool list it is given, not by prompting. The runtime itself ships no tools;
the Commander supplies its bounded project discovery and administration tools
through that registry.

## Providers

`ChatProvider` (`src/main/chat/providers/types.ts`) has one method:
`stream(request, signal)` yielding normalized events (`text_delta`,
`tool_call` with parsed input, `message_end` with a stop reason and usage).

- `anthropic.ts`: `@anthropic-ai/sdk` `messages.stream` with `tool_use` blocks.
  Default model `claude-haiku-4-5-20251001`.
- `openai-compatible.ts`: the `chat/completions` streaming format over plain
  `fetch`, no SDK. Works with OpenAI and local servers (Ollama, LM Studio,
  vLLM) via a configurable base URL. A key is optional off the hosted default.

Realtime/voice (#64): a realtime provider implements the same interface for
text and adds a session with audio in / audio events out; see the comment on
`ChatProvider`.

## Settings and keys

| Key             | Values                                   | Default                |
| --------------- | ---------------------------------------- | ---------------------- |
| `chat_provider` | `anthropic`, `openai-compatible`         | `anthropic`            |
| `chat_model`    | any model id                             | per provider           |
| `chat_base_url` | API root, e.g. `http://localhost:11434/v1` | provider default     |
| `chat_reasoning_effort` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | provider default |

The Commander composer exposes model and thinking selectors. Its model list
is built from every configured agent that saved a model, default agent first.
Claude Code agents and `claude`-named models route to Anthropic; any other
model routes to an OpenAI-compatible endpoint (see
`chatProviderForAgentModel` in `src/shared/chat.ts`). A model choice also
selects its provider and is persisted in these settings. Anthropic sends the
chosen level as `output_config.effort`;
OpenAI-compatible endpoints receive `reasoning_effort`. Leaving thinking at
Default omits the provider parameter.

API keys are not chat settings. `provider-factory.ts` reads the existing
`anthropic_api_key` / `openai_api_key` rows (encrypted at rest;
`DatabaseManager.getSetting` returns plaintext only in main) and falls back to
an agent's `config.api_keys`. The renderer never sees a key.

## IPC

- `chat:start({ messages, system?, maxToolCalls? })` → `{ turnId, provider, model }`.
  Only the main window's top frame may call it (`assertTrustedSender`). History
  is validated before any model call.
- `chat:cancel({ turnId })` → `{ cancelled }`. Only the window that started
  the turn may cancel it. Closing the window cancels its turns.
- `chat:event` → `{ turnId, event }`, sent through `guardedIpcSend`.

Renderer: `chatApi.start / cancel / onEvent` in `src/renderer/src/lib/ipc-client.ts`.

## Tests

`src/main/chat/**/*.test.ts` and `src/main/ipc/chat.test.ts`. Provider tests
use a fake `fetch` returning real SSE bodies, so the SDK parser and the
hand-written `chat/completions` parser both run end to end, including abort.

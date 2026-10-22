# Sprint 11 — Optional AI

**Status:** deferred (M4)

## Delivery scope

**M4 only**, under the contract in [PLAN.md](../PLAN.md) "Optional AI contract". Fully off by default.

## Direction

- An `ai` **action step**: `prompt` (template), `provider`, `model`, `output: insert | replace | templateTag`.
  The action system already provides confirmation, logging, cancellation and the keyring for keys.
- Providers: a local OpenAI-compatible endpoint (Ollama, llama.cpp) and one remote provider the user configures.
- The settings page states exactly what is sent (the rendered prompt, nothing else) and to whom.
- No automatic calls: AI runs only when an action with an `ai` step is run.

## Decisions

## Log

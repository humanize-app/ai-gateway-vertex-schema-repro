# AI Gateway: the requested JSON schema does not constrain output on `vertexAnthropic`

Minimal reproduction for a Vercel support ticket (ENG-2120). A JSON response format request for
`anthropic/claude-opus-5` returns a correct object every time when it routes to the `anthropic`
provider. Routed to `vertexAnthropic`, the schema does not appear to constrain generation at all.

Two symptoms, both arriving with `finishReason: stop` and no error from the Gateway:

1. The whole object arrives JSON-encoded as a string, inside a single-property wrapper the schema
   never mentions.
2. A required property is missing from an otherwise well formed object.

The second one is the more dangerous. The wrapper fails loudly at validation. A dropped property
passes any caller that does not validate strictly, so the request quietly returns a partial result.

## Reproduce

```bash
npm install
AI_GATEWAY_API_KEY=... npm run repro
```

Five runs per provider, then a tally. Exits non-zero if any run fails. Every run writes its request
body, response headers, and raw response stream to `raw/`.

A representative run:

```
vertexAnthropic: string-wrapped=2 valid=1 provider-unavailable=2
anthropic:       valid=5
```

Across sessions, 5 of the 6 `vertexAnthropic` runs that reached the model failed, and 10 of 10
`anthropic` runs were correct. The `provider-unavailable` runs are capacity 429s, expected once
`gateway.only` removes the fallback pool, and unrelated to this.

Generation ids, if these are easier to pull from your side:

| result | wrapper key | generation id |
| --- | --- | --- |
| string-wrapped | `parameters` | `gen_01M2TTZXQPPDP7AP860VZSEEGD` |
| string-wrapped | `parameter` | `gen_01M2TV0HFBYKTCMB7J2AXE345M` |
| string-wrapped | `uses` | `gen_01M2TV6DNAAXXTRJF5CYBPF7XW` |
| string-wrapped | `dispatch_agent` | `gen_01M2TV71T5JS9JNNT8P9VTZKX5` |
| valid, same provider | none | `gen_01M2TV07CF0DB4BN36B1XD5RGW` |

The production failure that opened the ticket is `gen_01M2HDTPMPTDE3R6G91Y4WC6TJ`, also with
`finishReason: stop`.

## Symptom 1: the object arrives as a string

Expected, and what `anthropic` returns:

```json
{ "overview": { "goals": "...", "participants": "..." }, "findings": [ ... ] }
```

Actual:

```json
{ "parameters": "{\"overview\": {\"goals\": \"...\", \"participants\": \"...\"}, \"findings\": [ ... ]}" }
```

The inner string parses to an object that matches the schema exactly. Only the envelope is wrong.

The envelope is not always a single property. One run returned invented sibling metadata around it:

```json
{ "tenantId": "demo", "payload": "{\"overview\":{\"goals\":\"Assess ease of setting and editing timers ...\"}}" }
```

Nothing in the prompt or the schema mentions a tenant. The property name changes on every run.
Collected so far:

`params`, `tool_use`, `tools`, `jsonrpc`, `input`, `parameters`, `request`, `msg`,
`dispatch_agent`, `dispatch_output`, `dict`, `text`, `value`, `uses`, `tel`, `of`, `but`, `p`,
`payload`, `paramCorrupted`

Most of those are tool-protocol vocabulary that appears in neither our prompt nor our schema.

## Symptom 2: a required property is dropped

`findings` is required with `minItems: 1`, and is simply absent:

```json
{ "overview": { "goals": "Assess ease of setting and monitoring timers ...", "participants": "Six home cooks, ages 24-61 ..." } }
```

Four consecutive runs of the `null-shallow` variant:

```
round 1  null-shallow   dropped-field finish=stop bytes=190
round 2  null-shallow   dropped-field finish=stop bytes=187
round 3  null-shallow   dropped-field finish=stop bytes=187
round 4  null-shallow   dropped-field finish=stop bytes=187
```

That rules out truncation. `finishReason` is `stop`, the JSON closes cleanly, and 187 bytes is
nowhere near the 4000-token budget. The model produced a short, complete object and stopped.

Over 15 runs this variant returned the dropped-field shape 12 times, the string wrapper once, and a
correct object twice.

## The response comes out of the Gateway this way

The wire log rules out client-side assembly. The request carries a well formed `responseFormat`
with the schema:

```json
{
  "responseFormat": {
    "type": "json",
    "schema": { "type": "object", "properties": { "overview": { ... }, "findings": { ... } } }
  },
  "toolChoice": { "type": "auto" }
}
```

The Gateway's own response stream carries the wrapper from its first text delta:

```
data: {"type":"response-metadata","id":"msg_vrtx_011CfBLyuqQKtoph9kWhiUt5","modelId":"claude-opus-5"}
data: {"type":"text-start","id":"0"}
data: {"type":"text-delta","id":"0","delta":"{\"parameters\": \"{\\\"over"}
data: {"type":"text-delta","id":"0","delta":"view\\\": {\\\"goals\\\": \\\""}
```

The client reassembles exactly what arrived. Full logs for both providers land in `raw/` after a run.

## Which schemas trigger it

Six variants, five rounds each, round-robin so provider-side variation over time hits every variant
equally. Only the marked field differs between the `-deep` variants. Run it with `npm run bisect`,
which takes `CASES`, `ROUNDS`, and `PROVIDER`.

| variant | what it changes | result over 5 runs |
| --- | --- | --- |
| `null-deep` | control: `themeName` is `string \| null` | wrapped=5 |
| `plain-deep` | `themeName` is a plain string | wrapped=3 valid=1 other=1 |
| `optional-deep` | `themeName` is optional, not nullable | wrapped=3 valid=1 other=1 |
| `union-deep` | `themeName` is `string \| number`, an `anyOf` with no null | wrapped=5 |
| `null-shallow` | nullable at depth 2, no array inside an array item | dropped-field=4 wrapped=1 |
| `null-flat` | nullable, no nesting at all | valid=5 |

Nesting is what separates the passing case from the failing ones, not any single schema feature.
`plain-deep` has no null and no `anyOf` and still fails, and `union-deep` fails on every run with an
`anyOf` that has no null branch. The flat object is the only variant that was correct every time.

## Why we read this as the schema not binding

A schema that constrained the output could not produce a wrapper property it never mentions, and
could not omit a property it marks required. The wrapper names read like tool-call scaffolding, and
this path emits no `reasoning-*` stream parts while the `anthropic` path does. That points at the
JSON response format being satisfied by instruction rather than by a schema-bearing tool call.

We cannot see the upstream Vertex request, so that last part is inference from the response side
rather than a claim about your adapter.

## Versions

- `ai@7.0.90`
- `@ai-sdk/gateway@4.0.72`
- `zod@4.4.3`
- Node 26.8.1 locally. The production failures that opened the ticket were on the Vercel Node runtime.

This reproduces from any runtime, because the defect is in the Gateway's response. We left out a
deployed variant on purpose: a full response can outrun a function budget, and a timeout would read
as a different failure. The generation ids above should let you pull these from the Gateway side.

## Our workaround

Pinning the affected requests to `providerOptions: { gateway: { only: ["anthropic"] } }`, which
costs us the fallback pool and the capacity that comes with it.

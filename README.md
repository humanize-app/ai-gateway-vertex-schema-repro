# AI Gateway: tool-call input comes back inside an extra envelope on `vertexAnthropic`

Minimal reproduction for a Vercel support ticket (ENG-2120). Requests for
`anthropic/claude-opus-5` that route to the `anthropic` provider are correct every time. Routed to
`vertexAnthropic`, the model's payload is correct but arrives one level too deep, inside something
shaped like a tool-use envelope. Everything comes back with `finishReason: stop` and no error from
the Gateway.

A plain forced tool call shows it most clearly. The tool is named `report`, and `toolCalls[0].input`
should be the report object. Instead:

```json
{ "report": { "overview": { "goals": "...", "participants": "..." }, "findings": [ ... ] } }
```

The inner object matches the tool's input schema exactly. It is the envelope that is wrong.

The envelope's shape varies between runs. Observed forms:

| form | example |
| --- | --- |
| keyed by the tool name | `{"report": {…the payload…}}` |
| an Anthropic tool-use block | `{"tool_use_id": "tool_1", "input": {…the payload…}}` |
| an arbitrary key, payload stringified | `{"value": "{\"overview\": …}"}` |
| an arbitrary key, payload nested | `{"paramCorrupted": {…the payload…}}` |

The `{"input": "…"}` form in our original report is the same bug: `input` is the payload field of an
Anthropic tool-use block.

This is not limited to structured output. Because it reaches plain tool calling, any tool call with
a non-trivial input schema on this path is exposed.

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

## It is not the API we chose

Every structured-output API the AI SDK offers fails on this provider, and so does a plain forced
tool call that uses no structured-output machinery at all. Three rounds each, same schema, same
prompt, `npm run usage-check`:

| call style | round 1 | round 2 | round 3 |
| --- | --- | --- | --- |
| `streamText` + `Output.object` | wrapped | mismatch | wrapped |
| `generateObject` | enveloped | enveloped | enveloped |
| `streamObject` | wrapped | wrapped | wrapped |
| `generateText` + forced tool call | enveloped | enveloped | enveloped |
| `Output.object`, thinking disabled | valid | wrapped | wrapped |

The forced tool call is the important row. It defines a tool with an input schema and sets
`toolChoice: { type: "tool", toolName: "report" }`, which is ordinary Anthropic tool use with no
response format involved. It still comes back enveloped.

Disabling extended thinking does not fix it either, though the `anthropic` path is the only one that
emits `reasoning-*` stream parts at all.

## Symptom: the payload arrives as a string

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

## Symptom: a required property is dropped

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

## Which schemas trigger it (response-format path)

Six variants, five rounds each, round-robin so provider-side variation over time hits every variant
equally. Only the marked field differs between the `-deep` variants. Run it with `npm run bisect`,
which takes `CASES`, `ROUNDS`, and `PROVIDER`. These cover the response-format path only. The
envelope reaches plain tool calls regardless of schema shape.

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

## How we read this

The payload is right and the envelope around it is wrong, across every call style including plain
tool use. That points at the tool-call input being wrapped a second time somewhere on this path
rather than handed back as-is.

What we cannot explain from outside is why the envelope's shape changes run to run. A fixed adapter
bug would presumably produce one consistent shape, so the model may be producing the envelope itself
in response to something it is being shown. Either way it is server-side: the Gateway's own response
stream carries the envelope from its first delta, and the client only reassembles what arrived.

We cannot see the upstream Vertex request, so this is inference from the response side rather than a
claim about your adapter.

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
costs us the fallback pool and the capacity that comes with it. Since this reaches plain tool
calling too, the pin has to cover every Claude request that uses a tool or a response format, not
just the one that surfaced the problem.

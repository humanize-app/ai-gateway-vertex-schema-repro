import { mkdirSync, writeFileSync } from "node:fs";
import { createGateway } from "@ai-sdk/gateway";
import { Output, streamText } from "ai";
import { z } from "zod";

const MODEL = process.env.MODEL ?? "anthropic/claude-opus-5";
const PROVIDERS = (process.env.PROVIDERS ?? "vertexAnthropic,anthropic")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
const RUNS = Number(process.env.RUNS ?? "5");
const RAW_DIR = process.env.RAW_DIR ?? "raw";

const ReportSchema = z.object({
    overview: z.object({
        goals: z.string(),
        participants: z.string(),
    }),
    findings: z
        .array(
            z.object({
                title: z.string(),
                summary: z.string(),
                objectiveIndexes: z.array(z.number().min(0)).min(1),
                fragments: z.array(z.object({ marker: z.string(), themeName: z.string().nullable() })),
            }),
        )
        .min(1),
});

const PROMPT =
    "Invent a two-finding usability report about a fictional kitchen timer app. Keep every string under 20 words.";

interface Exchange {
    url: string;
    requestBody: string;
    status: number;
    responseHeaders: Record<string, string>;
    responseBody: string;
    drained: Promise<void>;
}

function capturingFetch(exchanges: Exchange[]): typeof globalThis.fetch {
    return async (input, init) => {
        const response = await globalThis.fetch(input as Parameters<typeof globalThis.fetch>[0], init);
        const exchange: Exchange = {
            url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            requestBody: typeof init?.body === "string" ? init.body : "",
            status: response.status,
            responseHeaders: Object.fromEntries(response.headers.entries()),
            responseBody: "",
            drained: Promise.resolve(),
        };
        exchanges.push(exchange);
        if (!response.body) {
            exchange.responseBody = await response.clone().text();
            return response;
        }
        const [forCaller, forCapture] = response.body.tee();
        exchange.drained = (async () => {
            const reader = forCapture.getReader();
            const decoder = new TextDecoder();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                exchange.responseBody += decoder.decode(value, { stream: true });
            }
        })();
        return new Response(forCaller, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
}

type Outcome =
    | "valid"
    | "string-wrapped"
    | "schema-mismatch"
    | "unparseable"
    | "provider-unavailable"
    | "request-failed";

/**
 * The wrapper is not always a single property. Runs have also produced an envelope with invented
 * sibling metadata, such as {"tenantId": "demo", "payload": "<the object, as a string>"}. The
 * signature that holds across all of them is a string-valued property carrying JSON.
 */
function stringWrapper(value: unknown): { key: string; siblings: string[] } | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, inner] of entries) {
        if (typeof inner !== "string" || !inner.trimStart().startsWith("{")) {
            continue;
        }
        try {
            JSON.parse(inner);
        } catch {
            continue;
        }
        return { key, siblings: entries.map(([sibling]) => sibling).filter((sibling) => sibling !== key) };
    }
    return undefined;
}

function classify(text: string): { outcome: Outcome; note: string } {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        return { outcome: "unparseable", note: `JSON.parse failed: ${(error as Error).message}` };
    }
    if (ReportSchema.safeParse(value).success) {
        return { outcome: "valid", note: "matches the requested schema" };
    }
    const wrapper = stringWrapper(value);
    if (wrapper === undefined) {
        const issues = ReportSchema.safeParse(value)
            .error?.issues.slice(0, 3)
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
        return { outcome: "schema-mismatch", note: `well formed JSON that does not match the schema. ${issues}` };
    }
    const innerValid = ReportSchema.safeParse(JSON.parse((value as Record<string, string>)[wrapper.key]!)).success;
    const siblings = wrapper.siblings.length > 0 ? `, alongside invented ${wrapper.siblings.join(", ")}` : "";
    return {
        outcome: "string-wrapped",
        note: `wrapped in "${wrapper.key}"${siblings}; the inner string ${
            innerValid ? "is a schema-valid report" : "does not match the schema"
        }`,
    };
}

/** The gateway reports its generation id in a response header; the name has moved between releases. */
function findGenerationId(exchanges: Exchange[]): string | undefined {
    for (const exchange of exchanges) {
        for (const [key, value] of Object.entries(exchange.responseHeaders)) {
            if (key.toLowerCase().includes("generation") || /^gen_[A-Za-z0-9]+$/.test(value)) {
                return `${key}=${value}`;
            }
        }
    }
    return undefined;
}

interface AttemptResult {
    provider: string;
    run: number;
    outcome: Outcome;
    note: string;
    finishReason?: string;
    generationId?: string;
    validationError?: string;
    text: string;
    rawFile?: string;
}

async function attempt(provider: string, run: number): Promise<AttemptResult> {
    const exchanges: Exchange[] = [];
    const gateway = createGateway({ fetch: capturingFetch(exchanges) });

    const base: AttemptResult = { provider, run, outcome: "request-failed", note: "", text: "" };
    let streamError: unknown;
    try {
        const result = streamText({
            model: gateway(MODEL),
            maxOutputTokens: 4000,
            prompt: PROMPT,
            providerOptions: { gateway: { only: [provider] } },
            output: Output.object({ schema: ReportSchema }),
            onError: ({ error }) => {
                streamError ??= error;
            },
        });
        await result.consumeStream();
        await Promise.all(exchanges.map((exchange) => exchange.drained));

        base.text = await result.text;
        base.finishReason = await result.finishReason;
        try {
            await result.output;
        } catch (error) {
            base.validationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        Object.assign(base, classify(base.text));
    } catch (error) {
        const reported = streamError ?? error;
        base.note = reported instanceof Error ? `${reported.name}: ${reported.message}` : String(reported);
        // Restricting `gateway.only` to one provider removes the fallback pool, so
        // a capacity 429 is routine here and says nothing about the wrapping bug.
        if (/capacity|rate.?limit/i.test(base.note)) {
            base.outcome = "provider-unavailable";
        }
    }

    base.generationId = findGenerationId(exchanges);
    mkdirSync(RAW_DIR, { recursive: true });
    base.rawFile = `${RAW_DIR}/${provider}-${run}-${base.outcome}.txt`;
    writeFileSync(
        base.rawFile,
        exchanges
            .map((exchange) =>
                [
                    `# ${exchange.status} ${exchange.url}`,
                    "## request body",
                    exchange.requestBody,
                    "## response headers",
                    JSON.stringify(exchange.responseHeaders, null, 2),
                    "## response body",
                    exchange.responseBody,
                ].join("\n\n"),
            )
            .join("\n\n----------------------------------------\n\n"),
    );
    return base;
}

async function main(): Promise<void> {
    if (!process.env.AI_GATEWAY_API_KEY) {
        console.error("Set AI_GATEWAY_API_KEY before running.");
        process.exit(2);
    }
    console.log(`model=${MODEL} providers=${PROVIDERS.join(",")} runs=${RUNS}\n`);

    const results: AttemptResult[] = [];
    for (const provider of PROVIDERS) {
        for (let run = 1; run <= RUNS; run++) {
            const result = await attempt(provider, run);
            results.push(result);
            console.log(`[${provider} ${run}/${RUNS}] ${result.outcome} — ${result.note}`);
            console.log(`    finishReason=${result.finishReason} ${result.generationId ?? "(no generation id header)"}`);
            if (result.validationError) {
                console.log(`    Output.object() rejected with ${result.validationError}`);
            }
            if (result.outcome !== "valid" && result.text) {
                console.log(`    first 200 chars: ${result.text.slice(0, 200)}`);
            }
            console.log(`    raw wire log: ${result.rawFile}\n`);
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }

    console.log("summary");
    for (const provider of PROVIDERS) {
        const tally = results
            .filter((result) => result.provider === provider)
            .reduce<Record<string, number>>((acc, result) => {
                acc[result.outcome] = (acc[result.outcome] ?? 0) + 1;
                return acc;
            }, {});
        console.log(
            `  ${provider}: ${Object.entries(tally)
                .map(([outcome, count]) => `${outcome}=${count}`)
                .join(" ")}`,
        );
    }
    const failed = results.some(
        (result) => result.outcome === "string-wrapped" || result.outcome === "schema-mismatch",
    );
    process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}

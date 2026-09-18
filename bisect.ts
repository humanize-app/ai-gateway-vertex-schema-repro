import { mkdirSync, writeFileSync } from "node:fs";
import { createGateway } from "@ai-sdk/gateway";
import { Output, streamText } from "ai";
import { z } from "zod";

const gateway = createGateway({});
const MODEL = process.env.MODEL ?? "anthropic/claude-opus-5";
const PROVIDER = process.env.PROVIDER ?? "vertexAnthropic";
const ROUNDS = Number(process.env.ROUNDS ?? "5");

const PROMPT =
    "Invent a two-finding usability report about a fictional kitchen timer app. Keep every string under 20 words.";

/**
 * Every case is the same report shape. Only the marked field changes, so a
 * difference in outcome points at that field's JSON Schema translation.
 */
function report(fragment: z.ZodType) {
    return z.object({
        overview: z.object({ goals: z.string(), participants: z.string() }),
        findings: z
            .array(
                z.object({
                    title: z.string(),
                    summary: z.string(),
                    objectiveIndexes: z.array(z.number().min(0)).min(1),
                    fragments: z.array(fragment),
                }),
            )
            .min(1),
    });
}

const cases: Record<string, z.ZodType> = {
    // Positive control: themeName emits anyOf [string, null].
    "null-deep": report(z.object({ marker: z.string(), themeName: z.string().nullable() })),
    // Same depth, no null and no anyOf.
    "plain-deep": report(z.object({ marker: z.string(), themeName: z.string() })),
    // Absence expressed as optional (drops from `required`) rather than as a null type.
    "optional-deep": report(z.object({ marker: z.string(), themeName: z.string().optional() })),
    // anyOf without a null branch, to tell "anyOf" apart from "type: null".
    "union-deep": report(z.object({ marker: z.string(), themeName: z.union([z.string(), z.number()]) })),
    // Null at depth 2 instead of depth 4.
    "null-shallow": z.object({
        overview: z.object({ goals: z.string(), participants: z.string().nullable() }),
        findings: z.array(z.object({ title: z.string(), summary: z.string() })).min(1),
    }),
    // Null with no nesting at all.
    "null-flat": z.object({ marker: z.string(), themeName: z.string().nullable() }),
};

type Outcome = "valid" | "wrapped" | "dropped-field" | "invalid-other" | "unavailable";

const CASES_FILTER = process.env.CASES?.split(",").map((name) => name.trim());

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

async function attempt(
    schema: z.ZodType,
): Promise<{ outcome: Outcome; key?: string; text?: string; finishReason?: string }> {
    let streamError: unknown;
    try {
        const result = streamText({
            model: gateway(MODEL),
            maxOutputTokens: 4000,
            prompt: PROMPT,
            providerOptions: { gateway: { only: [PROVIDER] } },
            output: Output.object({ schema }),
            onError: ({ error }) => {
                streamError ??= error;
            },
        });
        await result.consumeStream();
        const text = await result.text;
        const finishReason = await result.finishReason;
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            return { outcome: "invalid-other", text, finishReason };
        }
        if (schema.safeParse(value).success) {
            return { outcome: "valid", finishReason };
        }
        const wrapper = stringWrapper(value);
        if (wrapper !== undefined) {
            return { outcome: "wrapped", key: wrapper.key, text, finishReason };
        }
        // Well formed JSON that simply omits a required property, the second symptom.
        const dropped = schema.safeParse(value).success === false && typeof value === "object" && value !== null;
        return { outcome: dropped ? "dropped-field" : "invalid-other", text, finishReason };
    } catch (error) {
        const reported = streamError ?? error;
        const message = reported instanceof Error ? reported.message : String(reported);
        return { outcome: /capacity|rate.?limit/i.test(message) ? "unavailable" : "invalid-other" };
    }
}

/** A capacity 429 is not a sample. Retry it rather than letting it thin the case out. */
async function sample(
    schema: z.ZodType,
): Promise<{ outcome: Outcome; key?: string; text?: string; finishReason?: string }> {
    for (let retry = 0; retry < 4; retry++) {
        const result = await attempt(schema);
        if (result.outcome !== "unavailable") {
            return result;
        }
        await new Promise((resolve) => setTimeout(resolve, 15000));
    }
    return { outcome: "unavailable" };
}

const tallies = new Map<string, Record<string, number>>();
const keysSeen = new Map<string, string[]>();
for (const name of Object.keys(cases)) {
    tallies.set(name, {});
    keysSeen.set(name, []);
}

console.log(`model=${MODEL} provider=${PROVIDER} rounds=${ROUNDS}\n`);
for (let round = 1; round <= ROUNDS; round++) {
    for (const [name, schema] of Object.entries(cases)) {
        if (CASES_FILTER && !CASES_FILTER.includes(name)) {
            continue;
        }
        const { outcome, key, text, finishReason } = await sample(schema);
        if (outcome !== "valid" && text) {
            mkdirSync("bisect-raw", { recursive: true });
            writeFileSync(`bisect-raw/${name}-${round}-${outcome}.json`, text);
        }
        const tally = tallies.get(name)!;
        tally[outcome] = (tally[outcome] ?? 0) + 1;
        if (key !== undefined) {
            keysSeen.get(name)!.push(key);
        }
        console.log(
            `round ${round}  ${name.padEnd(14)} ${outcome}${key ? ` in "${key}"` : ""} finish=${finishReason} bytes=${text?.length ?? 0}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    console.log("");
}

console.log("summary");
for (const name of Object.keys(cases)) {
    const tally = tallies.get(name)!;
    const keys = keysSeen.get(name)!;
    console.log(
        `  ${name.padEnd(14)} ${Object.entries(tally)
            .map(([outcome, count]) => `${outcome}=${count}`)
            .join(" ")}${keys.length > 0 ? `  keys: ${keys.join(", ")}` : ""}`,
    );
}

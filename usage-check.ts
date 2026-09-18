import { createGateway } from "@ai-sdk/gateway";
import { generateObject, generateText, Output, streamObject, streamText, tool } from "ai";
import { z } from "zod";

/**
 * Answers "are you holding it wrong". Runs the same schema through every structured-output API the
 * AI SDK offers, plus a plain forced tool call, against one gateway provider.
 */
const gateway = createGateway({});
const MODEL = "anthropic/claude-opus-5";
const PROVIDER = process.env.PROVIDER ?? "vertexAnthropic";
const ROUNDS = Number(process.env.ROUNDS ?? "3");

const ReportSchema = z.object({
    overview: z.object({ goals: z.string(), participants: z.string() }),
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
const gw = { gateway: { only: [PROVIDER] } };
const noThinking = { gateway: { only: [PROVIDER] }, anthropic: { thinking: { type: "disabled" as const } } };

function verdict(value: unknown): string {
    const parsed = ReportSchema.safeParse(value);
    if (parsed.success) {
        return "VALID";
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [key, inner] of Object.entries(value)) {
            if (typeof inner === "string" && inner.trimStart().startsWith("{")) {
                return `WRAPPED in "${key}"`;
            }
        }
        const missing = parsed.error.issues
            .filter((issue) => issue.message.includes("undefined"))
            .map((issue) => issue.path.join("."));
        return missing.length > 0 ? `MISSING ${missing.join(",")}` : "MISMATCH";
    }
    return "MISMATCH";
}

/** NoObjectGeneratedError carries the raw text the model produced, which is what we want to classify. */
function rawFromError(error: unknown): unknown {
    const text = (error as { text?: unknown })?.text;
    return typeof text === "string" ? parse(text) : undefined;
}

function parse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

const checks: Record<string, () => Promise<{ verdict: string; warnings: unknown }>> = {
    "streamText+Output": async () => {
        const result = streamText({
            model: gateway(MODEL),
            maxOutputTokens: 4000,
            prompt: PROMPT,
            providerOptions: gw,
            output: Output.object({ schema: ReportSchema }),
            onError: () => {},
        });
        await result.consumeStream();
        return { verdict: verdict(parse(await result.text)), warnings: await result.warnings };
    },
    generateObject: async () => {
        try {
            const result = await generateObject({
                model: gateway(MODEL),
                maxOutputTokens: 4000,
                prompt: PROMPT,
                providerOptions: gw,
                schema: ReportSchema,
            });
            return { verdict: verdict(result.object), warnings: result.warnings };
        } catch (error) {
            const raw = rawFromError(error);
            if (raw === undefined) {
                throw error;
            }
            console.log(`      generateObject raw: ${JSON.stringify(raw).slice(0, 300)}`);
            return { verdict: verdict(raw), warnings: [] };
        }
    },
    streamObject: async () => {
        const result = streamObject({
            model: gateway(MODEL),
            maxOutputTokens: 4000,
            prompt: PROMPT,
            providerOptions: gw,
            schema: ReportSchema,
            onError: () => {},
        });
        let text = "";
        for await (const chunk of result.textStream) {
            text += chunk;
        }
        try {
            return { verdict: verdict(await result.object), warnings: await result.warnings };
        } catch (error) {
            return { verdict: verdict(rawFromError(error) ?? parse(text)), warnings: [] };
        }
    },
    "forcedTool": async () => {
        const result = await generateText({
            model: gateway(MODEL),
            maxOutputTokens: 4000,
            prompt: PROMPT,
            providerOptions: gw,
            tools: { report: tool({ description: "Record the report", inputSchema: ReportSchema }) },
            toolChoice: { type: "tool", toolName: "report" },
        });
        const input = result.toolCalls[0]?.input;
        console.log(`      forcedTool toolCalls=${result.toolCalls.length} raw: ${JSON.stringify(input).slice(0, 300)}`);
        return { verdict: verdict(input), warnings: result.warnings };
    },
    "Output+noThinking": async () => {
        const result = streamText({
            model: gateway(MODEL),
            maxOutputTokens: 4000,
            prompt: PROMPT,
            providerOptions: noThinking,
            output: Output.object({ schema: ReportSchema }),
            onError: () => {},
        });
        await result.consumeStream();
        return { verdict: verdict(parse(await result.text)), warnings: await result.warnings };
    },
};

console.log(`provider=${PROVIDER} rounds=${ROUNDS}\n`);
const tally = new Map<string, string[]>();
for (const name of Object.keys(checks)) {
    tally.set(name, []);
}
for (let round = 1; round <= ROUNDS; round++) {
    for (const [name, run] of Object.entries(checks)) {
        let line: string;
        try {
            const { verdict: v, warnings } = await run();
            const warn = Array.isArray(warnings) && warnings.length > 0 ? ` warnings=${JSON.stringify(warnings)}` : "";
            line = `${v}${warn}`;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            line = /capacity|rate.?limit/i.test(message) ? "unavailable" : `ERROR ${message.slice(0, 90)}`;
        }
        tally.get(name)!.push(line.split(" ")[0]!);
        console.log(`round ${round}  ${name.padEnd(20)} ${line}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    console.log("");
}
console.log("summary");
for (const [name, outcomes] of tally) {
    console.log(`  ${name.padEnd(20)} ${outcomes.join("  ")}`);
}

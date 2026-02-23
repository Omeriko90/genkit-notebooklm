import { z } from "genkit";
import { ai } from "../config";
import { detectDomains, getPersonasForDomains, Persona } from "../config/personaLoader";

const discussionHooksInputSchema = z.object({
  summary: z.string(),
  domains: z.array(z.string()).optional(),
  format: z.enum(["roundtable", "debate", "interview"]).optional(),
});

const discussionHooksOutputSchema = z.object({
  hooks: z.array(z.string()),
  detectedDomains: z.array(z.string()),
});

function formatPersonas(personas: Persona[]): string {
  return personas
    .map(
      (p) =>
        `- **${p.name}** — ${p.credentials}\n  Expertise: ${p.expertise.join(", ")}\n  Speaking style: ${p.speakingStyle}`
    )
    .join("\n");
}

function getFormatInstruction(format?: string): string {
  switch (format) {
    case "debate":
      return "Lean toward polarizing, provocative hooks that set up opposing viewpoints. Frame hooks as tensions or disagreements between experts.";
    case "interview":
      return "Lean toward probing, investigative hooks. Frame hooks as deep-dive questions one expert would pose to another.";
    case "roundtable":
    default:
      return "Lean toward multi-perspective hooks. Frame hooks so that multiple experts can weigh in with different viewpoints.";
  }
}

export const discussionHooksFlow = ai.defineFlow(
  {
    name: "discussionHooksFlow",
    inputSchema: discussionHooksInputSchema,
    outputSchema: discussionHooksOutputSchema,
  },
  async (input: z.infer<typeof discussionHooksInputSchema>) => {
    const { summary, format } = input;

    const domainKeys = input.domains && input.domains.length > 0
      ? input.domains
      : detectDomains(summary);

    const personas = getPersonasForDomains(domainKeys);
    const personasBlock = formatPersonas(personas);
    const formatInstruction = getFormatInstruction(format);

    const prompt = `You are producing discussion hooks for a podcast episode. You have the following expert personas available:

${personasBlock}

Given the following source material summary:
====== BEGIN SUMMARY ======
${summary}
====== END SUMMARY ======

Generate 8-12 discussion hooks for a podcast conversation. Each hook should be substantial enough to sustain 2-3 minutes of discussion.

Requirements:
- Include a MIX of depth levels:
  • 2-3 SURFACE hooks: accessible entry points, surprising facts, or relatable angles that draw listeners in
  • 4-5 ANALYTICAL hooks: deeper examination of causes, mechanisms, trade-offs, or implications — referencing data or frameworks
  • 2-3 PROVOCATIVE hooks: bold claims, counterintuitive takes, or "devil's advocate" positions that spark debate
- Each hook MUST reference which persona(s) would drive it (use their name)
- Each hook should be a concise paragraph (2-4 sentences) introducing the angle, the driving question, and why it matters

Format guidance: ${formatInstruction}

Return each hook as a string in the hooks array. Also return the domain keys used in detectedDomains.`;

    const hookResponse = await ai.generate({
      prompt,
      config: { temperature: 0.7 },
      output: { schema: discussionHooksOutputSchema },
    });

    const output = hookResponse.output;
    return output || { hooks: [], detectedDomains: domainKeys };
  }
);

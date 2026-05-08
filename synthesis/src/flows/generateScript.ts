import { z } from "genkit";
import { ai } from "../config";
import { roundtablePodcastScriptFlow } from "./formats/roundtable";
import { debatePodcastScriptFlow } from "./formats/debate";
import { interviewPodcastScriptFlow } from "./formats/interview";
import { podcastOptionsSchema } from "../schemas/podcast";

export const generateScriptFlow = ai.defineFlow(
  {
    name: "generateScriptFlow",
    inputSchema: z.object({
      summary: z.string(),
      hooks: z.array(z.string()),
      options: podcastOptionsSchema,
      narrativeInstructions: z.string().optional(),
      tone: z.string().optional(),
    }),
    outputSchema: z.object({
      script: z.array(z.object({
        speaker: z.string(),
        text: z.string()
      })),
      storageUrl: z.string().optional()
    })
  },
  async (input) => {
    const { summary, hooks, options, narrativeInstructions, tone } = input;
    let scriptResult;
    switch (options.format) {
      case "roundtable":
        scriptResult = await roundtablePodcastScriptFlow({
          summary,
          options,
          hooks,
          narrativeInstructions,
          tone,
        });
        break;
      case "debate":
        scriptResult = await debatePodcastScriptFlow({
          summary,
          options,
          hooks,
          narrativeInstructions,
          tone,
        });
        break;
      case "interview":
        scriptResult = await interviewPodcastScriptFlow({
          summary,
          options,
          hooks,
          narrativeInstructions,
          tone,
        });
        break;
      default:
        throw new Error(`Unsupported podcast format`);
    }

    if (!scriptResult.script) {
      throw new Error("Script generation failed - no script content returned");
    }

    return {
      script: scriptResult.script,
    };
  }
);

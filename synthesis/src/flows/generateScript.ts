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
      options: podcastOptionsSchema
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
    let scriptResult;
    switch (input.options.format) {
      case "roundtable":
        scriptResult = await roundtablePodcastScriptFlow({
          summary: input.summary,
          options: input.options,
          hooks: input.hooks,
        });
        break;
      case "debate":
        scriptResult = await debatePodcastScriptFlow({
          summary: input.summary,
          options: input.options,
          hooks: input.hooks,
        });
        break;
      case "interview":
        scriptResult = await interviewPodcastScriptFlow({
          summary: input.summary,
          options: input.options,
          hooks: input.hooks,
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

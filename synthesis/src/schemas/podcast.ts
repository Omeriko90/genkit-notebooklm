import { z } from "genkit";
import { interviewPodcastOptionsSchema } from "./formats/interview";
import { roundtablePodcastOptionsSchema } from "./formats/roundtable";
import { debatePodcastOptionsSchema } from "./formats/debate";

export const podcastOptionsSchema = z.discriminatedUnion("format", [
  interviewPodcastOptionsSchema,
  roundtablePodcastOptionsSchema,
  debatePodcastOptionsSchema
]);

const VALID_DOMAINS = new Set(['tech', 'finance', 'coaching', 'wellbeing', 'psychology', 'general']);

export const synthesisRequestSchema = z.object({
  input: z.union([
    z.string().min(1).max(500_000),
    z.array(z.string().min(1).max(500_000)).min(1).max(20),
  ]),
  output: z.array(
    z.object({
      type: z.literal('podcast'),
      options: podcastOptionsSchema,
    })
  ).min(1).max(5),
  domains: z.array(
    z.string().refine(d => VALID_DOMAINS.has(d), { message: 'Invalid domain key' })
  ).max(6).optional(),
});

export type InterviewPodcastOptions = z.infer<typeof interviewPodcastOptionsSchema>;
export type RoundtablePodcastOptions = z.infer<typeof roundtablePodcastOptionsSchema>;
export type DebatePodcastOptions = z.infer<typeof debatePodcastOptionsSchema>;
export type PodcastOptions = InterviewPodcastOptions | RoundtablePodcastOptions | DebatePodcastOptions;

export type OutputType =
//  | "summary"
  | "podcast";

// Define the valid output configurations
export type OutputConfig =
//  | { type: "summary"; options: SummaryOptions }
  | { type: "podcast"; options: PodcastOptions }


/**
 * Main Synthesis Request
 */
export interface SynthesisRequest {
    /** The input source(s) for synthesis */
    input: string | string[]; // Supports multiple sources (PDFs, URLs, etc.)
    /** The desired output formats */
    output: OutputConfig[]; // Supports multiple output types in a single request
    /** Optional domain override for persona selection (e.g. ["tech", "finance"]) */
    domains?: string[];
  }

export interface SynthesisResult {
  //studyGuide?: StudyGuideSection[];
  podcast?: PodcastResult;
}

// TODO: Need to figure out how to handle remote storage of the actual files generated
export interface PodcastResult {
  transcript: string;
  storageUrl: string;
  audioFilename: string;
}

import personasData from "./personas.json";

export interface Persona {
  name: string;
  credentials: string;
  expertise: string[];
  speakingStyle: string;
}

export interface DomainConfig {
  label: string;
  keywords: string[];
  personas: Persona[];
}

const domains: Record<string, DomainConfig> = personasData;

/**
 * Scores keyword matches against the summary text and returns the top domain keys.
 * Falls back to ["general"] if no domain scores above the minimum threshold.
 */
export function detectDomains(summary: string, maxDomains = 2): string[] {
  const lowerSummary = summary.toLowerCase();
  const scores: { key: string; score: number }[] = [];

  for (const [key, config] of Object.entries(domains)) {
    if (key === "general") continue;
    let score = 0;
    for (const keyword of config.keywords) {
      const regex = new RegExp(`\\b${keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      const matches = lowerSummary.match(regex);
      if (matches) {
        score += matches.length;
      }
    }
    if (score > 0) {
      scores.push({ key, score });
    }
  }

  scores.sort((a, b) => b.score - a.score);

  const MIN_THRESHOLD = 3;
  const aboveThreshold = scores.filter((s) => s.score >= MIN_THRESHOLD);

  if (aboveThreshold.length === 0) {
    return ["general"];
  }

  return aboveThreshold.slice(0, maxDomains).map((s) => s.key);
}

/**
 * Returns the merged persona list for the given domain keys.
 */
export function getPersonasForDomains(domainKeys: string[]): Persona[] {
  const personas: Persona[] = [];
  for (const key of domainKeys) {
    const domain = domains[key];
    if (domain) {
      personas.push(...domain.personas);
    }
  }
  return personas;
}

export interface TraceSummary {
  packageName: string;
  eventCount: number;
}

export function createTraceSummary(): TraceSummary {
  return {
    packageName: "@aiagent/trace",
    eventCount: 0
  };
}

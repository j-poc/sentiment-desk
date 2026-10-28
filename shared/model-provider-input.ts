export const MODEL_PROVIDER_TITLE_CHAR_LIMIT = 500;
export const MODEL_PROVIDER_EXCERPT_CHAR_LIMIT = 4_000;

interface ModelProviderInputShape {
  company: { name: string; ticker: string; sector?: string };
  source: { collector: string; publisher: string; title: string; excerpt: string };
}

interface BoundedModelProviderInput {
  company: { name: string; ticker: string; sector: string };
  source: { collector: string; publisher: string; title: string; excerpt: string };
}

/** The exact text-size bounds shared by provider requests and the user consent preview. */
export function boundModelProviderInput(input: ModelProviderInputShape): BoundedModelProviderInput {
  return {
    company: {
      name: input.company.name.slice(0, 160),
      ticker: input.company.ticker.slice(0, 24),
      sector: input.company.sector === undefined ? "" : input.company.sector.slice(0, 120),
    },
    source: {
      collector: input.source.collector.slice(0, 48),
      publisher: input.source.publisher.slice(0, 120),
      title: input.source.title.slice(0, MODEL_PROVIDER_TITLE_CHAR_LIMIT),
      excerpt: input.source.excerpt.slice(0, MODEL_PROVIDER_EXCERPT_CHAR_LIMIT),
    },
  };
}

import type { ReviewCreatePayload, ReviewHierarchy } from './review-types.ts';
import {
  classifySummaryLines,
  labelSummary,
  parseV5Insights,
  sha256,
} from './v5-format.ts';

export function isReviewCreatePayload(
  value: unknown,
): value is ReviewCreatePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<ReviewCreatePayload>;
  if (
    typeof payload.projectName !== 'string' ||
    !payload.projectName.trim() ||
    typeof payload.sourcePath !== 'string' ||
    !payload.sourcePath.trim() ||
    typeof payload.summaryMarkdown !== 'string' ||
    typeof payload.insightMarkdown !== 'string'
  )
    return false;
  if (payload.format === 'v5') {
    return (
      typeof payload.summaryLabeledMarkdown === 'string' &&
      typeof payload.manifestJson === 'string' &&
      (payload.stage === 'insight' || payload.stage === 'redaction')
    );
  }
  return (
    (payload.format === undefined || payload.format === 'legacy') &&
    Boolean(payload.summaryMarkdown.trim() && payload.insightMarkdown.trim())
  );
}

/** Read the publisher's prepared payload without inferring or converting its schema. */
export async function parseReviewImportFile(text: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Choose a valid review import JSON file.');
  }
  if (!isReviewCreatePayload(payload) || payload.format !== 'v5') {
    throw new Error(
      'Choose a prepared run import JSON with its manifest, summary, and insights. Exported annotation bundles use a different format.',
    );
  }
  const review = await parseV5Review(payload);
  return { payload, review };
}

type RunManifest = {
  complete?: boolean;
  input_sha256?: string;
  configuration?: {
    protocol_version?: number;
    model?: string;
    reasoning_effort?: string;
  };
  stages?: Record<
    string,
    {
      status?: string;
      outputs?: { sha256?: Record<string, string> };
    }
  >;
};

// The v5 artifact format is shared by multiple run protocol versions.
export async function parseV5Review(payload: ReviewCreatePayload) {
  if (
    typeof payload.protocolVersion !== 'number' ||
    !Number.isSafeInteger(payload.protocolVersion) ||
    payload.protocolVersion <= 0 ||
    !payload.stage ||
    typeof payload.summaryLabeledMarkdown !== 'string' ||
    !payload.manifestJson
  ) {
    throw new Error(
      'A review requires a positive integer protocolVersion, stage, labeled Summary, and manifest.',
    );
  }
  let manifest: RunManifest;
  try {
    manifest = JSON.parse(payload.manifestJson) as RunManifest;
  } catch {
    throw new Error('The run manifest is not valid JSON.');
  }
  if (manifest?.configuration?.protocol_version !== payload.protocolVersion) {
    throw new Error(
      'The run manifest protocol version does not match the payload.',
    );
  }
  const stage = manifest.stages?.[payload.stage];
  if (stage?.status !== 'complete' || !stage.outputs?.sha256) {
    throw new Error(`The ${payload.stage} stage is not complete.`);
  }
  if (payload.stage === 'redaction' && manifest.complete !== true) {
    throw new Error('The privacy-redaction run is not complete.');
  }
  if (
    labelSummary(payload.summaryMarkdown) !== payload.summaryLabeledMarkdown
  ) {
    throw new Error('The labeled Summary does not match the readable Summary.');
  }
  const names =
    payload.stage === 'redaction'
      ? {
          summary: 'summary_redacted.md',
          labeled: 'summary_redacted_labeled.md',
          insight: 'insight_redacted.md',
        }
      : {
          summary: 'summary.md',
          labeled: 'summary_labeled.md',
          insight: 'insight.md',
        };
  const contents = {
    [names.summary]: payload.summaryMarkdown,
    [names.labeled]: payload.summaryLabeledMarkdown,
    [names.insight]: payload.insightMarkdown,
  };
  for (const [name, content] of Object.entries(contents)) {
    const expected = stage.outputs.sha256[name];
    if (!expected || (await sha256(content)) !== expected) {
      throw new Error(`The manifest hash for ${name} does not match.`);
    }
  }
  const summaryLines = classifySummaryLines(payload.summaryMarkdown);
  const insights = parseV5Insights(
    payload.insightMarkdown,
    summaryLines,
    payload.protocolVersion,
  );
  const hierarchy: ReviewHierarchy = {
    trajectorySummary: { originalText: '', text: '' },
    summaryGroups: [],
    format: 'v5',
    protocolVersion: payload.protocolVersion,
    stage: payload.stage,
    privacyStatus: payload.stage === 'redaction' ? 'redacted' : 'unredacted',
    provenance: {
      manifestSha256: await sha256(payload.manifestJson),
      inputSha256: manifest.input_sha256,
      artifactHashes: Object.fromEntries(
        Object.keys(contents).map((name) => [
          name,
          stage.outputs?.sha256?.[name] ?? '',
        ]),
      ),
      model: manifest.configuration.model,
      reasoningEffort: manifest.configuration.reasoning_effort,
      hashVerified: true,
      runComplete: manifest.complete === true,
    },
  };
  return { summaryLines, insights, hierarchy };
}

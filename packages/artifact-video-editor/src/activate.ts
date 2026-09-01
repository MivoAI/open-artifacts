import type {
  ArtifactActivationContext,
  DataBinding,
  JsonSchema,
  OaSdk,
  Registration,
} from '@open-artifacts/sdk';

import {
  createInitialProject,
  describeClipRange,
  readTimeline,
  resolveClipRange,
  trimTimelineClip,
} from './model.ts';
import type {
  TimelineReadOutput,
  TimelineTrimInput,
  TimelineTrimOutput,
  VideoClipRangeContext,
  VideoClipRangeSelection,
  VideoClipRangeSelector,
  VideoEditorInput,
  VideoProjectData,
} from './model.ts';

export const videoProjectDataSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['project', 'media', 'timeline', 'delivery'],
  properties: {
    project: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'sequence'],
      properties: {
        name: { type: 'string', minLength: 1 },
        sequence: { type: 'string', minLength: 1 },
      },
    },
    media: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'kind', 'durationUs', 'dimensions'],
      properties: {
        id: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        kind: { type: 'string', minLength: 1 },
        durationUs: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        dimensions: { type: 'string', minLength: 1 },
      },
    },
    timeline: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'tracks'],
      properties: {
        id: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        tracks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'kind', 'label', 'clips'],
            properties: {
              id: { type: 'string', minLength: 1 },
              kind: { const: 'video' },
              label: { type: 'string', minLength: 1 },
              clips: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'mediaId', 'title', 'sourceRange'],
                  properties: {
                    id: { type: 'string', minLength: 1 },
                    mediaId: { type: 'string', minLength: 1 },
                    title: { type: 'string', minLength: 1 },
                    sourceRange: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['sourceStartUs', 'sourceEndUs'],
                      properties: {
                        sourceStartUs: {
                          type: 'integer',
                          minimum: 0,
                          maximum: Number.MAX_SAFE_INTEGER,
                        },
                        sourceEndUs: {
                          type: 'integer',
                          minimum: 1,
                          maximum: Number.MAX_SAFE_INTEGER,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    delivery: {
      type: 'object',
      additionalProperties: false,
      required: ['treatments', 'targetPlatform', 'aspectRatio'],
      properties: {
        treatments: {
          type: 'array',
          uniqueItems: true,
          items: {
            enum: ['tighten-pacing', 'captions', 'music-bed'],
          },
        },
        targetPlatform: {
          enum: ['tiktok', 'instagram-reels', 'youtube-shorts'],
        },
        aspectRatio: {
          enum: ['9:16', '1:1', '16:9'],
        },
      },
    },
  },
} as const satisfies JsonSchema;

const emptyInputSchema = {
  type: 'object',
  additionalProperties: false,
} as const satisfies JsonSchema;

const timelineReadOutputSchema = videoProjectDataSchema;

const timelineTrimInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['clipId', 'sourceStartUs', 'sourceEndUs'],
  properties: {
    clipId: { type: 'string', minLength: 1 },
    sourceStartUs: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    sourceEndUs: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const satisfies JsonSchema;

const timeRangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceStartUs', 'sourceEndUs'],
  properties: {
    sourceStartUs: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    sourceEndUs: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

const timelineTrimOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['clipId', 'previousRange', 'range', 'removedDurationUs'],
  properties: {
    clipId: { type: 'string', minLength: 1 },
    previousRange: timeRangeSchema,
    range: timeRangeSchema,
    removedDurationUs: { type: 'integer', minimum: 0 },
  },
} as const satisfies JsonSchema;

export function bindVideoProject(
  oa: OaSdk,
  input: Readonly<VideoEditorInput>,
): DataBinding<VideoProjectData> {
  return oa.data.bind<VideoProjectData>('project.json', {
    initial: () => createInitialProject(input),
    schema: videoProjectDataSchema,
  });
}

export async function activate({
  oa,
  input,
}: ArtifactActivationContext<VideoEditorInput>): Promise<() => void> {
  const project = bindVideoProject(oa, input);
  const registrations: Registration[] = [];

  registrations.push(
    oa.tool.register<Record<string, never>, TimelineReadOutput>({
      name: 'timeline.read',
      title: 'Read timeline',
      description: 'Read the current authoritative video timeline and clip source ranges.',
      effects: {
        data: 'read',
      },
      inputSchema: emptyInputSchema,
      outputSchema: timelineReadOutputSchema,
      handler: async () => readTimeline((await project.read()).data),
    }),
  );

  registrations.push(
    oa.tool.register<TimelineTrimInput, TimelineTrimOutput>({
      name: 'timeline.trim',
      title: 'Trim timeline clip',
      description:
        'Trim one video clip to a smaller source range expressed in integer microseconds.',
      effects: {
        data: 'write',
      },
      inputSchema: timelineTrimInputSchema,
      outputSchema: timelineTrimOutputSchema,
      handler: async (trimInput) => {
        let output: TimelineTrimOutput | undefined;
        await project.update(
          (current) => {
            const result = trimTimelineClip(current, trimInput);
            output = result.output;
            return result.project;
          },
          {
            reason: `tool.timeline.trim:${trimInput.clipId}`,
          },
        );
        if (!output) throw new Error('timeline.trim completed without a domain result');
        return output;
      },
    }),
  );

  registrations.push(
    oa.annotation.registerTargetProvider<
      VideoClipRangeSelection,
      VideoClipRangeSelector,
      VideoClipRangeContext
    >({
      name: 'video.clip-range',
      title: 'Video clip time range',
      describe: async (selection) => describeClipRange((await project.read()).data, selection),
      resolve: async (selector) => resolveClipRange((await project.read()).data, selector),
    }),
  );

  return () => {
    for (const registration of registrations.reverse()) registration.dispose();
  };
}

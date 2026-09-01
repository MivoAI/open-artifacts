import { describe, expect, it } from 'vitest';

import exampleInput from '../example.json';
import {
  createInitialProject,
  describeClipRange,
  resolveClipRange,
  TimelineDomainError,
  trimTimelineClip,
} from './model.ts';
import type { VideoEditorInput } from './model.ts';

const input = exampleInput as VideoEditorInput;

describe('Video Editor timeline model', () => {
  it('trims a clip to an authoritative microsecond range', () => {
    const project = createInitialProject(input);

    const result = trimTimelineClip(project, {
      clipId: 'opening-clip',
      sourceStartUs: 200_000,
      sourceEndUs: 1_200_000,
    });

    expect(result.output).toEqual({
      clipId: 'opening-clip',
      previousRange: {
        sourceStartUs: 0,
        sourceEndUs: 1_466_667,
      },
      range: {
        sourceStartUs: 200_000,
        sourceEndUs: 1_200_000,
      },
      removedDurationUs: 466_667,
    });
    expect(result.project.timeline.tracks[0]?.clips[0]?.sourceRange).toEqual({
      sourceStartUs: 200_000,
      sourceEndUs: 1_200_000,
    });
    expect(project.timeline.tracks[0]?.clips[0]?.sourceRange).toEqual({
      sourceStartUs: 0,
      sourceEndUs: 1_466_667,
    });
  });

  it('rejects a trim that expands beyond the current clip range', () => {
    const project = createInitialProject(input);

    let thrown: unknown;
    try {
      trimTimelineClip(project, {
        clipId: 'opening-clip',
        sourceStartUs: 0,
        sourceEndUs: 1_500_000,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TimelineDomainError);
    expect((thrown as TimelineDomainError).code).toBe('TRIM_OUT_OF_BOUNDS');
  });

  it('captures a stable video range selector and resolves it against current Instance Data', () => {
    const initialProject = createInitialProject(input);
    const descriptor = describeClipRange(initialProject, {
      clipId: 'opening-clip',
      sourceStartUs: 200_000,
      sourceEndUs: 500_000,
    });
    const trimmedProject = trimTimelineClip(initialProject, {
      clipId: 'opening-clip',
      sourceStartUs: 300_000,
      sourceEndUs: 1_200_000,
    }).project;

    expect(descriptor.selector).toEqual({
      kind: 'video.clip-range',
      timelineId: 'opening-study',
      clipId: 'opening-clip',
      sourceStartUs: 200_000,
      sourceEndUs: 500_000,
    });
    expect(resolveClipRange(initialProject, descriptor.selector).status).toBe('resolved');
    expect(resolveClipRange(trimmedProject, descriptor.selector)).toEqual({
      status: 'orphaned',
      reason: 'The selected source range is no longer present in the current clip.',
    });
  });
});

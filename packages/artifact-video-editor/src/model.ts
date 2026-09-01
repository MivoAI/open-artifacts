export type VideoTreatment = 'tighten-pacing' | 'captions' | 'music-bed';
export type TargetPlatform = 'tiktok' | 'instagram-reels' | 'youtube-shorts';
export type AspectRatio = '9:16' | '1:1' | '16:9';

export interface VideoDelivery {
  treatments: VideoTreatment[];
  targetPlatform: TargetPlatform;
  aspectRatio: AspectRatio;
}

export interface VideoEditorInput {
  project: {
    name: string;
    sequence: string;
  };
  media: {
    id: string;
    title: string;
    kind: string;
    durationUs: number;
    dimensions: string;
  };
  timeline: {
    id: string;
    title: string;
    trackId: string;
    trackLabel: string;
    clipId: string;
  };
  delivery: VideoDelivery;
}

export interface VideoTimeRange {
  sourceStartUs: number;
  sourceEndUs: number;
}

export interface VideoClip {
  id: string;
  mediaId: string;
  title: string;
  sourceRange: VideoTimeRange;
}

export interface VideoTrack {
  id: string;
  kind: 'video';
  label: string;
  clips: VideoClip[];
}

export interface VideoProjectData {
  project: VideoEditorInput['project'];
  media: VideoEditorInput['media'];
  timeline: {
    id: string;
    title: string;
    tracks: VideoTrack[];
  };
  delivery: VideoDelivery;
}

export interface TimelineTrimInput extends VideoTimeRange {
  clipId: string;
}

export interface TimelineTrimOutput {
  clipId: string;
  previousRange: VideoTimeRange;
  range: VideoTimeRange;
  removedDurationUs: number;
}

export interface TimelineReadOutput {
  project: VideoProjectData['project'];
  media: VideoProjectData['media'];
  timeline: VideoProjectData['timeline'];
  delivery: VideoDelivery;
}

export interface VideoClipRangeSelection extends VideoTimeRange {
  clipId: string;
}

export interface VideoClipRangeSelector extends VideoClipRangeSelection {
  kind: 'video.clip-range';
  timelineId: string;
}

export interface VideoClipRangeContext extends VideoClipRangeSelection {
  clipTitle: string;
  mediaId: string;
  timelineId: string;
}

export interface VideoClipRangeDescriptor {
  selector: VideoClipRangeSelector;
  context: VideoClipRangeContext;
  presentation: {
    title: string;
    summary: string;
    fields: Array<{ label: string; value: string }>;
  };
}

export type VideoClipRangeResolution =
  | {
      status: 'resolved';
      context: VideoClipRangeContext;
      presentation: VideoClipRangeDescriptor['presentation'];
    }
  | {
      status: 'orphaned' | 'unsupported';
      reason: string;
    };

export type TimelineDomainErrorCode =
  'CLIP_NOT_FOUND' | 'INVALID_TIME_RANGE' | 'TRIM_OUT_OF_BOUNDS';

export class TimelineDomainError extends Error {
  readonly code: TimelineDomainErrorCode;

  constructor(code: TimelineDomainErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'TimelineDomainError';
  }
}

export function createInitialProject(input: Readonly<VideoEditorInput>): VideoProjectData {
  return {
    project: { ...input.project },
    media: { ...input.media },
    timeline: {
      id: input.timeline.id,
      title: input.timeline.title,
      tracks: [
        {
          id: input.timeline.trackId,
          kind: 'video',
          label: input.timeline.trackLabel,
          clips: [
            {
              id: input.timeline.clipId,
              mediaId: input.media.id,
              title: input.media.title,
              sourceRange: {
                sourceStartUs: 0,
                sourceEndUs: input.media.durationUs,
              },
            },
          ],
        },
      ],
    },
    delivery: {
      ...input.delivery,
      treatments: [...input.delivery.treatments],
    },
  };
}

export function readTimeline(project: VideoProjectData): TimelineReadOutput {
  return structuredClone(project);
}

export function trimTimelineClip(
  project: VideoProjectData,
  input: TimelineTrimInput,
): { project: VideoProjectData; output: TimelineTrimOutput } {
  assertTimeRange(input);
  const match = findClip(project, input.clipId);
  if (!match) {
    throw new TimelineDomainError('CLIP_NOT_FOUND', `Unknown timeline clip: ${input.clipId}`);
  }

  const previousRange = match.clip.sourceRange;
  if (
    input.sourceStartUs < previousRange.sourceStartUs ||
    input.sourceEndUs > previousRange.sourceEndUs
  ) {
    throw new TimelineDomainError(
      'TRIM_OUT_OF_BOUNDS',
      'A trim must remain within the clip current source range.',
    );
  }

  const range = {
    sourceStartUs: input.sourceStartUs,
    sourceEndUs: input.sourceEndUs,
  };
  const tracks = project.timeline.tracks.map((track) =>
    track.id === match.track.id
      ? {
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === match.clip.id ? { ...clip, sourceRange: range } : clip,
          ),
        }
      : track,
  );

  return {
    project: {
      ...project,
      timeline: {
        ...project.timeline,
        tracks,
      },
    },
    output: {
      clipId: match.clip.id,
      previousRange: { ...previousRange },
      range,
      removedDurationUs:
        previousRange.sourceEndUs -
        previousRange.sourceStartUs -
        (range.sourceEndUs - range.sourceStartUs),
    },
  };
}

export function describeClipRange(
  project: VideoProjectData,
  selection: VideoClipRangeSelection,
): VideoClipRangeDescriptor {
  assertTimeRange(selection);
  const match = findClip(project, selection.clipId);
  if (!match) {
    throw new TimelineDomainError('CLIP_NOT_FOUND', `Unknown timeline clip: ${selection.clipId}`);
  }
  if (
    selection.sourceStartUs < match.clip.sourceRange.sourceStartUs ||
    selection.sourceEndUs > match.clip.sourceRange.sourceEndUs
  ) {
    throw new TimelineDomainError(
      'TRIM_OUT_OF_BOUNDS',
      'The selected time range must remain within the current clip.',
    );
  }

  return descriptorFor(project, match.clip, selection);
}

export function resolveClipRange(
  project: VideoProjectData,
  selector: VideoClipRangeSelector,
): VideoClipRangeResolution {
  if (selector.kind !== 'video.clip-range' || selector.timelineId !== project.timeline.id) {
    return {
      status: 'unsupported',
      reason: 'The current Video Editor Package does not support this target selector.',
    };
  }

  const match = findClip(project, selector.clipId);
  if (!match) {
    return {
      status: 'orphaned',
      reason: 'The selected clip no longer exists in the current Instance Data.',
    };
  }
  if (
    selector.sourceStartUs < match.clip.sourceRange.sourceStartUs ||
    selector.sourceEndUs > match.clip.sourceRange.sourceEndUs
  ) {
    return {
      status: 'orphaned',
      reason: 'The selected source range is no longer present in the current clip.',
    };
  }

  const descriptor = descriptorFor(project, match.clip, selector);
  return {
    status: 'resolved',
    context: descriptor.context,
    presentation: descriptor.presentation,
  };
}

function assertTimeRange(range: VideoTimeRange) {
  if (
    !Number.isSafeInteger(range.sourceStartUs) ||
    !Number.isSafeInteger(range.sourceEndUs) ||
    range.sourceStartUs < 0 ||
    range.sourceEndUs <= range.sourceStartUs
  ) {
    throw new TimelineDomainError(
      'INVALID_TIME_RANGE',
      'Video time ranges use non-negative integer microseconds and must have positive duration.',
    );
  }
}

function findClip(project: VideoProjectData, clipId: string) {
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { clip, track };
  }
  return undefined;
}

function descriptorFor(
  project: VideoProjectData,
  clip: VideoClip,
  range: VideoTimeRange,
): VideoClipRangeDescriptor {
  const context = {
    clipId: clip.id,
    clipTitle: clip.title,
    mediaId: clip.mediaId,
    timelineId: project.timeline.id,
    sourceStartUs: range.sourceStartUs,
    sourceEndUs: range.sourceEndUs,
  };

  return {
    selector: {
      kind: 'video.clip-range',
      timelineId: project.timeline.id,
      clipId: clip.id,
      sourceStartUs: range.sourceStartUs,
      sourceEndUs: range.sourceEndUs,
    },
    context,
    presentation: {
      title: `${clip.title} · selected range`,
      summary: `${formatMicroseconds(range.sourceStartUs)}–${formatMicroseconds(range.sourceEndUs)}`,
      fields: [
        { label: 'Timeline', value: project.timeline.title },
        { label: 'Clip', value: clip.id },
        { label: 'Media', value: clip.mediaId },
      ],
    },
  };
}

function formatMicroseconds(value: number) {
  return `${(value / 1_000_000).toFixed(3)}s`;
}

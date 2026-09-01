import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

import type { ArtifactRenderProps, DataBinding, OaSdk } from '@open-artifacts/sdk';
import { useAnnotationTarget, useDataBinding } from '@open-artifacts/sdk/react';

import { bindVideoProject } from './activate.ts';
import { createInitialProject } from './model.ts';
import type {
  VideoClip,
  VideoClipRangeContext,
  VideoClipRangeSelection,
  VideoClipRangeSelector,
  VideoEditorInput,
  VideoProjectData,
} from './model.ts';
import './styles.css';

type LegacyPreviewProps = {
  data: VideoEditorInput;
};

export type VideoEditorProps = ArtifactRenderProps<VideoEditorInput> | LegacyPreviewProps;

const demoVideoUrl = new URL('../assets/demo-h264.mp4', import.meta.url).href;
const demoPosterUrl = new URL('../assets/demo-poster.jpg', import.meta.url).href;

export default function VideoEditor(props: VideoEditorProps) {
  if ('oa' in props) {
    return <BoundVideoEditor input={props.input} oa={props.oa} />;
  }

  return (
    <VideoEditorSurface
      bindingState={{ revision: null, status: 'preview' }}
      project={createInitialProject(props.data)}
    />
  );
}

function BoundVideoEditor({ input, oa }: ArtifactRenderProps<VideoEditorInput>) {
  const binding = useMemo(() => bindVideoProject(oa, input), [input, oa]);
  return <BoundVideoEditorSnapshot binding={binding} oa={oa} />;
}

function BoundVideoEditorSnapshot({
  binding,
  oa,
}: {
  binding: DataBinding<VideoProjectData>;
  oa: OaSdk;
}) {
  const snapshot = useDataBinding(binding);
  if (snapshot.status === 'loading') {
    return (
      <main aria-busy="true" className="oa-video-editor ve-empty" data-testid="video-loading">
        Loading Instance Data…
      </main>
    );
  }
  return (
    <VideoEditorSurface
      bindingState={{ revision: snapshot.revision, status: snapshot.status }}
      oa={oa}
      project={snapshot.data}
    />
  );
}

function VideoEditorSurface({
  bindingState,
  oa,
  project,
}: {
  bindingState: {
    revision: string | null;
    status: string;
  };
  oa?: OaSdk;
  project: VideoProjectData;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const clip = project.timeline.tracks[0]?.clips[0];
  if (!clip)
    return <main className="oa-video-editor ve-empty">The timeline has no video clip.</main>;

  return (
    <VideoTimelineEditor
      bindingState={bindingState}
      clip={clip}
      oa={oa}
      project={project}
      videoRef={videoRef}
    />
  );
}

function VideoTimelineEditor({
  bindingState,
  clip,
  oa,
  project,
  videoRef,
}: {
  bindingState: {
    revision: string | null;
    status: string;
  };
  clip: VideoClip;
  oa: OaSdk | undefined;
  project: VideoProjectData;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [currentTimeUs, setCurrentTimeUs] = useState(clip.sourceRange.sourceStartUs);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selection, setSelection] = useState<VideoClipRangeSelection>(() => ({
    clipId: clip.id,
    ...clip.sourceRange,
  }));

  useEffect(() => {
    setCurrentTimeUs((current) =>
      clamp(current, clip.sourceRange.sourceStartUs, clip.sourceRange.sourceEndUs),
    );
    setSelection((current) => ({
      clipId: clip.id,
      sourceStartUs: clamp(
        current.sourceStartUs,
        clip.sourceRange.sourceStartUs,
        clip.sourceRange.sourceEndUs - 1,
      ),
      sourceEndUs: clamp(
        current.sourceEndUs,
        clip.sourceRange.sourceStartUs + 1,
        clip.sourceRange.sourceEndUs,
      ),
    }));
  }, [clip.id, clip.sourceRange.sourceEndUs, clip.sourceRange.sourceStartUs]);

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (
      video.currentTime * 1_000_000 < clip.sourceRange.sourceStartUs ||
      video.currentTime * 1_000_000 >= clip.sourceRange.sourceEndUs
    ) {
      video.currentTime = clip.sourceRange.sourceStartUs / 1_000_000;
    }
    if (video.paused) await video.play();
    else video.pause();
  };

  const scrub = (timeUs: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = timeUs / 1_000_000;
    setCurrentTimeUs(timeUs);
  };

  const markSelectionStart = () => {
    setSelection((current) => ({
      ...current,
      clipId: clip.id,
      sourceStartUs: Math.min(currentTimeUs, current.sourceEndUs - 1),
    }));
  };

  const markSelectionEnd = () => {
    setSelection((current) => ({
      ...current,
      clipId: clip.id,
      sourceEndUs: Math.max(currentTimeUs, current.sourceStartUs + 1),
    }));
  };

  const clipLeft = '0%';
  const clipWidth = `${
    ((clip.sourceRange.sourceEndUs - clip.sourceRange.sourceStartUs) / project.media.durationUs) *
    100
  }%`;
  const playheadLeft = `${
    ((currentTimeUs - clip.sourceRange.sourceStartUs) / project.media.durationUs) * 100
  }%`;

  return (
    <main className="oa-video-editor">
      <header className="ve-project-bar" data-testid="project-bar">
        <div>
          <small>{project.project.sequence}</small>
          <h1>{project.project.name}</h1>
        </div>
        <div className="ve-authority-state">
          <span>Instance Data</span>
          <strong data-testid="project-status">{bindingState.status}</strong>
          <code>{bindingState.revision ?? 'preview'}</code>
        </div>
      </header>

      <div className="ve-editor-grid">
        <aside className="ve-media-library" data-testid="media-library">
          <div className="ve-panel-heading">
            <div>
              <small>Package media</small>
              <strong>Source</strong>
            </div>
            <span>1 asset</span>
          </div>
          <article className="ve-media-card" data-testid={`media-card-${project.media.id}`}>
            <div className="ve-media-thumbnail">
              <video
                aria-hidden="true"
                muted
                poster={demoPosterUrl}
                preload="metadata"
                src={demoVideoUrl}
              />
              <span>{formatTimeUs(project.media.durationUs)}</span>
            </div>
            <strong>{project.media.title}</strong>
            <span>
              {project.media.kind} · {project.media.dimensions}
            </span>
          </article>
          <div className="ve-delivery">
            <small>Delivery</small>
            <strong>
              {project.delivery.targetPlatform} · {project.delivery.aspectRatio}
            </strong>
            <span>{project.delivery.treatments.join(' · ') || 'No treatments'}</span>
          </div>
        </aside>

        <section className="ve-editor-workspace" data-testid="editor-workspace">
          <div className="ve-preview-stage" data-testid="preview-surface">
            <div className="ve-preview-heading">
              <div>
                <small>Preview</small>
                <strong>{project.timeline.title}</strong>
              </div>
              <span>
                {formatTimeUs(clip.sourceRange.sourceStartUs)}–
                {formatTimeUs(clip.sourceRange.sourceEndUs)}
              </span>
            </div>
            <div className="ve-video-shell">
              <div
                className="ve-video-frame"
                data-aspect-ratio={project.delivery.aspectRatio}
                data-testid="preview-frame"
                style={{ aspectRatio: project.delivery.aspectRatio.replace(':', ' / ') }}
              >
                <video
                  data-testid="preview-video"
                  onEnded={() => setIsPlaying(false)}
                  onPause={() => setIsPlaying(false)}
                  onPlay={() => setIsPlaying(true)}
                  onTimeUpdate={(event) => {
                    const nextTimeUs = Math.round(event.currentTarget.currentTime * 1_000_000);
                    if (nextTimeUs >= clip.sourceRange.sourceEndUs) {
                      event.currentTarget.pause();
                      event.currentTarget.currentTime = clip.sourceRange.sourceEndUs / 1_000_000;
                      setCurrentTimeUs(clip.sourceRange.sourceEndUs);
                      return;
                    }
                    setCurrentTimeUs(nextTimeUs);
                  }}
                  playsInline
                  poster={demoPosterUrl}
                  preload="auto"
                  ref={videoRef}
                  src={demoVideoUrl}
                />
              </div>
            </div>
            <div className="ve-transport">
              <span>{formatTimeUs(currentTimeUs)}</span>
              <button
                aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
                className="ve-play-toggle"
                onClick={() => void togglePlayback()}
                type="button"
              >
                {isPlaying ? 'Ⅱ' : '▶'}
              </button>
              <span>{formatTimeUs(clip.sourceRange.sourceEndUs)}</span>
            </div>
          </div>

          <section className="ve-timeline-panel" data-testid="timeline-surface">
            <header className="ve-timeline-toolbar">
              <div>
                <small>Authoritative timeline</small>
                <strong>{project.timeline.tracks[0]?.label}</strong>
              </div>
              <code data-time-us={currentTimeUs} data-testid="timeline-time">
                {formatTimeUs(currentTimeUs)}
              </code>
            </header>

            <div className="ve-selection-toolbar">
              <span>
                Annotation range · {formatTimeUs(selection.sourceStartUs)}–
                {formatTimeUs(selection.sourceEndUs)}
              </span>
              <div>
                <button onClick={markSelectionStart} type="button">
                  Mark start
                </button>
                <button onClick={markSelectionEnd} type="button">
                  Mark end
                </button>
              </div>
            </div>

            <div className="ve-timeline-canvas">
              <div className="ve-track-label">
                <span>V1</span>
                <strong>{project.timeline.tracks[0]?.label}</strong>
              </div>
              <div className="ve-track-lane">
                {oa ? (
                  <TargetableClip
                    clip={clip}
                    left={clipLeft}
                    oa={oa}
                    selection={selection}
                    width={clipWidth}
                  />
                ) : (
                  <StaticClip clip={clip} left={clipLeft} width={clipWidth} />
                )}
                <div
                  className="ve-playhead"
                  data-testid="timeline-playhead"
                  style={{ left: playheadLeft }}
                >
                  <span />
                </div>
                <input
                  aria-label="Timeline scrubber"
                  className="ve-scrubber"
                  max={clip.sourceRange.sourceEndUs}
                  min={clip.sourceRange.sourceStartUs}
                  onChange={(event) => scrub(Number(event.currentTarget.value))}
                  step="1000"
                  type="range"
                  value={currentTimeUs}
                />
              </div>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

function TargetableClip({
  clip,
  left,
  oa,
  selection,
  width,
}: {
  clip: VideoClip;
  left: string;
  oa: OaSdk;
  selection: VideoClipRangeSelection;
  width: string;
}) {
  const target = useAnnotationTarget<
    VideoClipRangeSelection,
    VideoClipRangeSelector,
    VideoClipRangeContext
  >({
    oa,
    provider: 'video.clip-range',
    selection,
  });

  return (
    <button
      {...target.props}
      aria-label={`Select ${clip.title} annotation range`}
      className="ve-timeline-clip"
      data-source-end-us={clip.sourceRange.sourceEndUs}
      data-source-start-us={clip.sourceRange.sourceStartUs}
      data-testid={`timeline-clip-${clip.id}`}
      onClick={() => void target.select(selection, 'selection')}
      style={{ left, width }}
      type="button"
    >
      <span className="ve-clip-filmstrip" />
      <strong>{clip.title}</strong>
      <small>
        {formatTimeUs(selection.sourceStartUs)}–{formatTimeUs(selection.sourceEndUs)}
      </small>
    </button>
  );
}

function StaticClip({ clip, left, width }: { clip: VideoClip; left: string; width: string }) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') event.currentTarget.click();
  };
  return (
    <button
      className="ve-timeline-clip"
      data-source-end-us={clip.sourceRange.sourceEndUs}
      data-source-start-us={clip.sourceRange.sourceStartUs}
      data-testid={`timeline-clip-${clip.id}`}
      onKeyDown={handleKeyDown}
      style={{ left, width }}
      type="button"
    >
      <span className="ve-clip-filmstrip" />
      <strong>{clip.title}</strong>
    </button>
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function formatTimeUs(value: number) {
  const seconds = Math.max(0, value) / 1_000_000;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`;
}

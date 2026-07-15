import { useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import type { VideoEditorInput } from './model.ts';
import './styles.css';

export interface VideoEditorProps {
  data: VideoEditorInput;
}

const demoVideoUrl = new URL('../assets/demo-h264.mp4', import.meta.url).href;
const demoPosterUrl = new URL('../assets/demo-poster.jpg', import.meta.url).href;

function formatTime(value: number) {
  const seconds = Math.max(0, value);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(2).padStart(5, '0')}`;
}

export default function VideoEditor({ data }: VideoEditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(data.media.durationSeconds);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);

  const selectMedia = () => setSelectedMediaId(data.media.id);

  const handleSelectionKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectMedia();
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) await video.play();
    else video.pause();
  };

  const scrub = (event: ChangeEvent<HTMLInputElement>) => {
    const time = Number(event.currentTarget.value);
    const video = videoRef.current;
    if (video) video.currentTime = time;
    setCurrentTime(time);
  };

  const selected = selectedMediaId === data.media.id;
  const playheadPosition = duration > 0 ? `${(currentTime / duration) * 100}%` : '0%';

  return (
    <main className="oa-video-editor">
      <header className="ve-project-bar" data-testid="project-bar">
        <div className="ve-brand" aria-label="Open Artifacts">
          <span className="ve-brand-mark">OA</span>
          <strong>Open Artifacts</strong>
        </div>
        <div className="ve-project-identity">
          <small>{data.project.sequence}</small>
          <h1>{data.project.name}</h1>
        </div>
        <div className="ve-project-actions">
          <span className="ve-save-state">{data.project.status}</span>
          <button type="button">Share review</button>
          <button className="ve-primary-action" type="button">
            Export draft
          </button>
        </div>
      </header>

      <div className="ve-editor-grid">
        <aside className="ve-agent-surface" data-testid="agent-surface">
          <div className="ve-panel-heading">
            <span className="ve-agent-dot" />
            <div>
              <small>{data.agent.eyebrow}</small>
              <strong>Agent desk</strong>
            </div>
          </div>
          <div className="ve-agent-brief">
            <span className="ve-brief-label">Working brief</span>
            <h2>{data.agent.title}</h2>
            <p>{data.agent.summary}</p>
            <ol>
              {data.agent.tasks.map((task, index) => (
                <li key={task}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  {task}
                </li>
              ))}
            </ol>
          </div>
          <div className="ve-agent-composer">
            <p>{data.agent.composerPlaceholder}</p>
            <div>
              <button aria-label="Attach context" type="button">
                +
              </button>
              <span>Agent can inspect this session</span>
              <button aria-label="Send instruction" type="button">
                ↑
              </button>
            </div>
          </div>
        </aside>

        <aside className="ve-media-library" data-testid="media-library">
          <div className="ve-panel-heading ve-library-heading">
            <div>
              <small>Project media</small>
              <strong>Library</strong>
            </div>
            <button aria-label="Add media" type="button">
              +
            </button>
          </div>
          <div className="ve-library-tools">
            <span>1 asset</span>
            <button type="button">Sort: recent</button>
          </div>
          <div
            aria-selected={selected}
            className={`ve-media-card${selected ? ' is-selected' : ''}`}
            data-testid={`media-card-${data.media.id}`}
            onClick={selectMedia}
            onKeyDown={handleSelectionKeyDown}
            role="option"
            tabIndex={0}
          >
            <div className="ve-media-thumbnail">
              <video
                aria-hidden="true"
                muted
                poster={demoPosterUrl}
                preload="metadata"
                src={demoVideoUrl}
              />
              <span>{formatTime(data.media.durationSeconds)}</span>
            </div>
            <div className="ve-media-meta">
              <strong>{data.media.title}</strong>
              <span>
                {data.media.kind} · {data.media.dimensions}
              </span>
            </div>
          </div>
          <div className="ve-library-footnote">
            <span>Package-owned media</span>
            <code>assets/demo-h264.mp4</code>
          </div>
        </aside>

        <section className="ve-editor-workspace" data-testid="editor-workspace">
          <div className="ve-preview-stage" data-testid="preview-surface">
            <div className="ve-preview-heading">
              <div>
                <small>Preview</small>
                <strong>{data.timeline.title}</strong>
              </div>
              <span>Fit · 100%</span>
            </div>
            <div className="ve-video-shell">
              <video
                data-testid="preview-video"
                onDurationChange={(event) => setDuration(event.currentTarget.duration)}
                onEnded={() => setIsPlaying(false)}
                onPause={() => setIsPlaying(false)}
                onPlay={() => setIsPlaying(true)}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                playsInline
                poster={demoPosterUrl}
                preload="auto"
                ref={videoRef}
                src={demoVideoUrl}
              />
            </div>
            <div className="ve-transport">
              <span>{formatTime(currentTime)}</span>
              <button
                aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
                className="ve-play-toggle"
                onClick={() => void togglePlayback()}
                type="button"
              >
                {isPlaying ? 'Ⅱ' : '▶'}
              </button>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          <div className="ve-timeline-panel" data-testid="timeline-surface">
            <div className="ve-timeline-toolbar">
              <div>
                <button type="button">Split</button>
                <button type="button">Snap on</button>
              </div>
              <strong data-time={currentTime.toFixed(2)} data-testid="timeline-time">
                {formatTime(currentTime)}
              </strong>
              <span>100%</span>
            </div>
            <div className="ve-ruler" aria-hidden="true">
              <span>00:00</span>
              <span>00:00.50</span>
              <span>00:01.00</span>
              <span>00:01.47</span>
            </div>
            <div className="ve-timeline-canvas">
              <div className="ve-track-label">
                <span>V1</span>
                <strong>{data.timeline.trackLabel}</strong>
              </div>
              <div className="ve-track-lane">
                <div
                  aria-selected={selected}
                  className={`ve-timeline-clip${selected ? ' is-selected' : ''}`}
                  data-testid={`timeline-clip-${data.media.id}`}
                  onClick={selectMedia}
                  onKeyDown={handleSelectionKeyDown}
                  role="option"
                  tabIndex={0}
                >
                  <div className="ve-clip-filmstrip" />
                  <strong>{data.media.title}</strong>
                  <span>{data.media.kind}</span>
                </div>
                <div
                  className="ve-playhead"
                  data-testid="timeline-playhead"
                  style={{ left: playheadPosition }}
                >
                  <span />
                </div>
                <input
                  aria-label="Timeline scrubber"
                  className="ve-scrubber"
                  max={duration}
                  min="0"
                  onChange={scrub}
                  step="0.01"
                  type="range"
                  value={currentTime}
                />
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

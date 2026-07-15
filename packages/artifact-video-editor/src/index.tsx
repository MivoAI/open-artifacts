import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import type {
  AgentBrief,
  AspectRatio,
  TargetPlatform,
  VideoEditorInput,
  VideoTreatment,
} from './model.ts';
import './styles.css';

export interface VideoEditorProps {
  data: VideoEditorInput;
}

const demoVideoUrl = new URL('../assets/demo-h264.mp4', import.meta.url).href;
const demoPosterUrl = new URL('../assets/demo-poster.jpg', import.meta.url).href;

const treatmentLabels: Record<VideoTreatment, string> = {
  'tighten-pacing': 'Tighten pacing',
  captions: 'Captions',
  'music-bed': 'Music bed',
};

const platformLabels: Record<TargetPlatform, string> = {
  tiktok: 'TikTok',
  'instagram-reels': 'Instagram Reels',
  'youtube-shorts': 'YouTube Shorts',
};

const treatments = Object.keys(treatmentLabels) as VideoTreatment[];

function copyBrief(brief: AgentBrief): AgentBrief {
  return { ...brief, treatments: [...brief.treatments] };
}

function briefsEqual(left: AgentBrief, right: AgentBrief) {
  return (
    left.targetPlatform === right.targetPlatform &&
    left.aspectRatio === right.aspectRatio &&
    left.treatments.length === right.treatments.length &&
    left.treatments.every((treatment) => right.treatments.includes(treatment))
  );
}

function formatTime(value: number) {
  const seconds = Math.max(0, value);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(2).padStart(5, '0')}`;
}

export default function VideoEditor({ data }: VideoEditorProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const exportDialogRef = useRef<HTMLDialogElement>(null);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(data.media.durationSeconds);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [draftBrief, setDraftBrief] = useState(() => copyBrief(data.brief));
  const [activeBrief, setActiveBrief] = useState(() => copyBrief(data.brief));
  const [conversation, setConversation] = useState<AgentBrief[]>([]);
  const [projectStatus, setProjectStatus] = useState(data.project.status);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    const dialog = exportDialogRef.current;
    if (!dialog) return;

    if (exportOpen && !dialog.open) dialog.showModal();
    if (!exportOpen && dialog.open) dialog.close();
  }, [exportOpen]);

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

  const updateTreatment = (treatment: VideoTreatment, checked: boolean) => {
    setDraftBrief((current) => ({
      ...current,
      treatments: checked
        ? [...current.treatments, treatment]
        : current.treatments.filter((item) => item !== treatment),
    }));
  };

  const applyBrief = () => {
    if (briefsEqual(draftBrief, activeBrief)) return;
    const appliedBrief = copyBrief(draftBrief);
    setActiveBrief(appliedBrief);
    setConversation((current) => [...current, appliedBrief]);
    setProjectStatus('Unexported changes');
  };

  const selected = selectedMediaId === data.media.id;
  const briefChanged = !briefsEqual(draftBrief, activeBrief);
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
          <span className="ve-save-state" data-testid="project-status">
            {projectStatus}
          </span>
          <button type="button">Share review</button>
          <button
            className="ve-primary-action"
            onClick={() => setExportOpen(true)}
            ref={exportTriggerRef}
            type="button"
          >
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
          <div className="ve-agent-body">
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

            <div aria-label="Conversation" className="ve-conversation">
              {conversation.map((brief, index) => (
                <article data-testid="conversation-summary" key={index}>
                  <small>Applied brief {String(index + 1).padStart(2, '0')}</small>
                  <strong>
                    {brief.treatments.map((item) => treatmentLabels[item]).join(', ')}
                  </strong>
                  <span>
                    {platformLabels[brief.targetPlatform]} · {brief.aspectRatio}
                  </span>
                </article>
              ))}
            </div>

            <form
              aria-label="Agent Brief"
              className="ve-agent-composer"
              onSubmit={(event) => {
                event.preventDefault();
                applyBrief();
              }}
            >
              <span className="ve-brief-label">Artifact Input · Agent Brief</span>
              <p>{data.agent.composerPlaceholder}</p>
              <fieldset>
                <legend>Treatments</legend>
                {treatments.map((treatment) => (
                  <label key={treatment}>
                    <input
                      checked={draftBrief.treatments.includes(treatment)}
                      onChange={(event) => updateTreatment(treatment, event.currentTarget.checked)}
                      type="checkbox"
                    />
                    {treatmentLabels[treatment]}
                  </label>
                ))}
              </fieldset>
              <label>
                Target platform
                <select
                  onChange={(event) => {
                    const targetPlatform = event.currentTarget.value as TargetPlatform;
                    setDraftBrief((current) => ({ ...current, targetPlatform }));
                  }}
                  value={draftBrief.targetPlatform}
                >
                  <option value="tiktok">TikTok</option>
                  <option value="instagram-reels">Instagram Reels</option>
                  <option value="youtube-shorts">YouTube Shorts</option>
                </select>
              </label>
              <label>
                Aspect ratio
                <select
                  onChange={(event) => {
                    const aspectRatio = event.currentTarget.value as AspectRatio;
                    setDraftBrief((current) => ({ ...current, aspectRatio }));
                  }}
                  value={draftBrief.aspectRatio}
                >
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                  <option value="16:9">16:9</option>
                </select>
              </label>
              <button disabled={draftBrief.treatments.length === 0 || !briefChanged} type="submit">
                Apply brief
              </button>
            </form>
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
              <div
                className="ve-video-frame"
                data-aspect-ratio={activeBrief.aspectRatio}
                data-testid="preview-frame"
                style={{ aspectRatio: activeBrief.aspectRatio.replace(':', ' / ') }}
              >
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
                <ul aria-label="Applied treatment tracks" data-testid="treatment-tracks">
                  {activeBrief.treatments.map((treatment) => (
                    <li key={treatment}>{treatmentLabels[treatment]}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>
      </div>
      <dialog
        aria-label="Export summary"
        className="ve-export-dialog"
        onClose={() => {
          setExportOpen(false);
          exportTriggerRef.current?.focus();
        }}
        ref={exportDialogRef}
      >
        <span className="ve-brief-label">Simulation only</span>
        <h2>Export summary</h2>
        <strong>
          {platformLabels[activeBrief.targetPlatform]} · {activeBrief.aspectRatio}
        </strong>
        <p>{activeBrief.treatments.map((item) => treatmentLabels[item]).join(', ')}</p>
        <button onClick={() => setExportOpen(false)} type="button">
          Close summary
        </button>
      </dialog>
    </main>
  );
}

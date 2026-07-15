# Video Editor Render

An original Open Artifacts editing surface that lets an Agent and a person inspect the same real
video, playback state, playhead, and selection. The viewport is divided into a project bar, Agent
surface, media library, and preview/timeline workspace.

The Artifact Input shape is `{ project, agent, media, timeline, brief }`. The Brief selects one or
more editing treatments, a target platform, and an aspect ratio from the finite options in
`input.schema.json`; a complete input is in `example.json`. The default export accepts only
`{ data }`. React is supplied as a peer dependency, while the source, scoped CSS, and demo media are
owned by this package.

## Demo media

`assets/demo-h264.mp4` is a package-owned browser derivative of the approved local demo. It is H.264
High Profile, yuv420p, 1280 × 856 with AAC-LC stereo audio and fast-start metadata. It is included to
make a fresh local Session immediately playable without external URLs. `assets/demo-poster.jpg` is a
still derived from the same package-owned video for its initial preview state.

## Run and fork locally

From the Open Artifacts repository root:

```bash
node apps/cli/dist/cli/index.js run ./packages/artifact-video-editor --json --no-open
cp -R packages/artifact-video-editor packages/artifact-my-editor
```

After copying, rename the npm package, run `npm install` from the repository root, and edit
`src/index.tsx`, `src/styles.css`, the Input Contract, and the media asset in place. No Host registry
change is required.

# Video Editor Artifact Package

This Package defines a small source-first video editing Artifact. Its named `activate` export binds
authoritative Instance Data at `project.json`, registers the `timeline.read` and `timeline.trim`
Artifact Tools, and registers the `video.clip-range` Annotation Target Provider. The default export
renders the same Data through the Artifact UI.

The Artifact Input shape is `{ project, media, timeline, delivery }`. It initializes one source
asset, one video track, and one clip. Authoritative time ranges use integer microseconds. Runtime
renders receive `{ oa, input }`; `{ data }` remains available only as a compatibility path for the
legacy source preview. React and `@open-artifacts/sdk` are peer dependencies.

Playback position, hover, and the current time-range Selection remain local UI state. A successful
`timeline.trim` commits a new `project.json` revision through the SDK Data Binding, and Binding
subscribers update the visible clip range without a page reload.

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

# PROTOTYPE — Artifact renderer structures

Question: can one Artifact Package support multiple high-density layouts and retain stable annotation
targets across all of them?

Three variants live on the same route and switch through `?variant=atlas`, `?variant=brief`, and
`?variant=trace`.

## Design plan

- Color: paper `#FBFCFE`, cloud `#EEF1F5`, ink `#17212B`, blueprint `#2C5BE6`, annotation
  `#A749F5`, evidence `#0B8F73`.
- Type: Avenir Next for interface and compressed headings, Iowan Old Style for the reading-led Brief,
  and SF Mono for paths, metadata, and measurements.
- Signature: a deliberately imperfect purple grease-pencil ring marks the selected semantic target.
  It is the only expressive decoration; everything else encodes hierarchy or state.
- Motion: one short ring-draw transition. No ambient animation.

```text
┌ JSON package ┐ ┌──────── rendered artifact ────────┐ ┌ annotation ┐
│ live source  │ │ Atlas / Brief / Trace             │ │ target path│
│ parse state  │ │ same data, different hierarchy    │ │ comment    │
└──────────────┘ └────────────────────────────────────┘ └────────────┘
                              [ ← variant → ]
```

The first visual draft risked becoming a generic dark AI dashboard. The revision uses a light evidence
workspace, reserves color for protocol state and annotation, and makes the three variants disagree
about information hierarchy rather than palette.

## Variant hypotheses

- Atlas wins when simultaneous visibility and cross-checking matter.
- Brief wins when a reader needs a guided first pass before inspecting detail.
- Trace wins when provenance and the relationship from evidence to action matter.

## Verdict

Pending browser review. Once a structure wins, absorb its validated interaction model into the real
renderer and delete the losing prototype variants and switcher.

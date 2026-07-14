# Open Artifacts

Open Artifacts defines a source-first bridge that turns an Artifact Package into an Artifact Session
that a person and an Agent can both access. This glossary is the canonical language for the product;
command names, documentation, and code should use these terms consistently.

## Artifact language

**Artifact Package**:
A versioned, source-published unit that defines an interactive browser surface, its accepted input,
and everything needed to understand and modify that surface.
_Avoid_: Render Package, template, plugin, generated page

**Artifact Reference**:
A value that identifies where an Artifact Package can be resolved, such as a package specifier or a
local source location. The `<artifact>` argument in `oa run <artifact>` is an Artifact Reference.
_Avoid_: Artifact ID, URL, package name when referring to all supported reference forms

**Artifact Source**:
The editable implementation included in an Artifact Package. It is the knowledge a developer or
Agent owns after making a Local Fork.
_Avoid_: build output, bundle, generated website

**Artifact Input**:
The JSON-compatible value supplied to an Artifact Package to produce one Render. It contains the
artifact's content or data, not the implementation of its interface.
_Avoid_: props, payload, response

**Input Contract**:
The package-owned description of valid Artifact Input. It defines the data boundary between an
Artifact Package and an Artifact Session.
_Avoid_: API contract, component props

**Example Input**:
The package-owned Artifact Input used when no other input is supplied. It makes an Artifact Package
immediately inspectable after it is run.
_Avoid_: mock data, seed data, default state

**Render**:
The interactive browser surface produced from one Artifact Package and one Artifact Input. A Render
is an active expression of an Artifact Package, not a distributable package or a static export.
_Avoid_: Artifact, website, screenshot, output file

## Runtime language

**Artifact Session**:
One active execution of one resolved Artifact Package. It has its own identity, URL, and lifetime,
and may grow to hold shared interaction state without becoming a different kind of object.
_Avoid_: OA Server, Runtime Session, Editor, Host

**Session ID**:
A locally unique identifier for one Artifact Session. It distinguishes concurrent Sessions
independently of their Artifact Package or network address.
_Avoid_: Artifact ID, process ID, Server ID

**Session URL**:
The local browser address of one Artifact Session. A person or an Agent may open the same Session URL using
their own browser capabilities.
_Avoid_: Artifact URL, Server URL, preview URL when referring to the canonical running address

**Active Session**:
An Artifact Session whose Render is currently available at its Session URL. `oa session list`
reports Active Sessions, not historical runs or installed Artifact Packages.
_Avoid_: Server, project, workspace

**Workbench**:
The browser shell that presents a Render together with OA-owned runtime information or controls. It
is part of the Artifact Session experience, not part of the Artifact Package being rendered.
_Avoid_: Host, dashboard, Artifact Package UI

## Ownership language

**Local Fork**:
An independently editable copy of Artifact Source with recorded upstream provenance. It is source
ownership, not a copy of an Artifact Session or a fork on a Git hosting service.
_Avoid_: GitHub fork, duplicate Render, copied Artifact Session

## Reserved collaboration language

**Annotation**:
A future durable comment attached to a structured target inside an Artifact Session. It is not
ordinary Artifact Input or an implementation note in Artifact Source.
_Avoid_: comment when the target and lifecycle matter

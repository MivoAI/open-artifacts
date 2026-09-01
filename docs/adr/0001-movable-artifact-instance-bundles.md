---
status: accepted
---

# Persist Artifact Instances as movable bundles

Each Artifact Instance is persisted in one `<name>.openartifact` directory bundle. OA creates and
hosts the bundle under `~/.open-artifacts/instances/` by default so a new Instance works without the
user choosing a project location, while keeping the Instance's identity, managed Data history,
Annotations, Bindings, and Package Binding together.

A user may migrate the same bundle into a project or another user-managed location. Migration
preserves the Instance ID and all persisted contents; it is not a copy or fork. After migration, the
new location is the only authoritative bundle, and OA Home retains only an Instance Registration
that associates the Instance ID with that location. OA must not maintain a shadow copy or silently
fall back to stale data at the former location.

The bundle may keep an internal Git repository for OA-managed Data revisions. This internal history
remains an OA implementation detail. A project that needs its outer Git repository to own and
review existing files directly should keep those files outside the bundle and connect them through
Data Bindings instead of making the same files members of two Git working trees.

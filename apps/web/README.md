# Open Artifacts web host

This Vite app is intentionally a thin local host. At startup its Vite plugin discovers
`packages/artifact-*`, then loads each package's manifest, schema, example, and default React source
through public npm exports before mounting `<Render data={input} />`.

Package-specific layouts, types, styles, and visualization dependencies do not belong here. The host
owns only catalog UI, JSON editing, URL selection, error isolation, and the React runtime.

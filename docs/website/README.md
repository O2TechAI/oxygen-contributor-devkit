# Live homepage copy

The public Oxygen homepage is a self-contained static HTML bundle. This change
keeps its section order, visual assets, animation hooks, and existing design.
`homepage-copy.json` records the original and replacement copy, including the
animated sentences. The wording explains the research, the value of reviewing a
participant's own projects, and concrete ways to begin. Reference matching is
identified as the current evaluation; application on new tasks is a research goal.
The user confirmed the public collaboration figures: approximately 100 researchers
and 40 ongoing projects spanning safety, manufacturing, AI for Science, electrical
engineering, and biomedical engineering. These appear in the existing first-screen
green banner.

## Generate a candidate

Download the current public homepage to a separate file, then run:

```sh
python3 tools/rewrite-oxygen-homepage.py /tmp/oxygen-original.html /tmp/oxygen-candidate.html
```

The script refuses to overwrite its input and rejects unexpected occurrence
counts instead of silently applying a partial rewrite. Keep the input bundle
and generated candidate outside Git; this repository tracks only copy and the
reproducible transformation. The asset manifest is preserved byte for byte.

The patch also replaces an old catch-all email click handler with explicit
native links: project quick start, an evaluation email, and the devkit repository.
The bundled document's head receives the page title. Small wrapping and mobile
font adjustments accommodate the new copy without changing the layout.

## Verify and publish

Serve the generated candidate locally. Check desktop, narrow mobile, and low
height windows; expand the four cards, inspect pipeline steps, open the mobile
menu, follow section links, and check the three contribution destinations.
The project quick-start anchor must exist in the public repository.

Publish only after browser verification. Compare the live file hash with the
original, save a backup outside the public document root, preserve the existing
owner and permissions, and atomically replace the served `index.html`. If the
live hash changed, stop and regenerate against that version. Verify the HTTPS
response and actual rendered page after publication. A rollback likewise checks
that the deployed hash is still current before restoring the backup.

# Demo adapter

This adapter is a portable example for the script tools bundled in `dsh-crawshrimp-browser`. It reads `document.title`, extracts text from the first HTML table, and copies the declared `params.label` into one JSON row.

The example uses the portable subset only: `manifest.yaml` declares a manual trigger and one text parameter; the task points to one async IIFE JavaScript file that returns `{ success, data, meta }`. The same script can read the Crawshrimp-compatible `window.__CRAWSHRIMP_PARAMS__` alias and page globals when it is extended for pagination.

# design-sync notes — tidepool

- This repo consumes the design system; it does not build it. The system (components/, tokens/, styles.css, _ds_bundle.js) is authored in the Claude Design project "Tidepool Design System" and mirrored at the repo root. Do not run the converter here — sync is a targeted write-back of `ui_kits/tidepool-webui/**` only.
- The production WebUI (`public/index.html`) loads the kit screens from `/kit` (= `ui_kits/tidepool-webui/`) at runtime, so any local kit edit is live in prod immediately but stale in the design project until written back. Write back after kit edits.
- 2026-07-08: first write-back. Remote kit files were one generation older than even the pre-session local mirror (earlier sessions had edited the kit locally without writing back) — full 8-file upload, local as source of truth. No deletes needed.
- Kit verification happens in-repo: screens run against the real API in the browser (plus the /kit fake-data mock), on the same bundle/styles the project holds — no separate preview grading applies to these plain kit files.

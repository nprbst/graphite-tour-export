# Graphite Tour Export

Chrome extension that extracts [Graphite](https://app.graphite.com) PR Tour content as portable Markdown. Tours are AI-generated guided walkthroughs of code changes — narrative prose interleaved with annotated diffs — but they're locked inside Graphite's UI. This extension makes them shareable: copy to clipboard for pasting into Linear issues or Slack threads, or pre-fill a GitHub PR comment directly.

## Features

- **Copy as Markdown** — extracts the full tour (section headings, narrative prose, code diffs) to your clipboard
- **Comment on GitHub PR** — opens the corresponding GitHub PR and pre-fills the comment textarea with the tour content. You review and click Submit — no API token needed, uses your existing GitHub session.

## Install

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select this directory
5. Pin the extension icon in the toolbar for easy access

## Usage

1. Open a PR on [Graphite](https://app.graphite.com) and switch to **Tour** mode (the "Tour" tab next to "Files")
2. Click the extension icon in the toolbar
3. Choose **Copy as Markdown** or **Comment on GitHub PR**
4. The extension will scroll through the page to render and capture all diff content — you'll see progress like `Rendering diffs... (5/32)` in the popup. This takes 30-90 seconds depending on the PR size.
5. Once complete, the markdown is on your clipboard (or the GitHub PR page opens with the comment pre-filled)

## Output format

The extracted markdown includes:

- A link back to the Graphite tour
- Table of contents with all section headings
- Each tour section as `## Heading` with narrative prose (preserving bold, inline code, lists)
- Code diffs inside collapsible `<details>` blocks, one per file card
- Multiple hunks from the same file rendered as separate ` ```diff ` blocks within a single `<details>`
- Files that failed to load (e.g., large generated files like `Tables.scala`) get a tombstone message instead of being silently dropped

Example output structure:

```markdown
> Exported from [Graphite Tour](https://app.graphite.com/github/pr/owner/repo/123?mode=tour)

## Table of Contents
- [Overview](#overview)
- [Schema changes](#schema-changes)
...

## Overview

This PR introduces a **census ledger skeleton** — a system that tracks...

## Schema changes

`stats_dimensions` / `stats_dimension_values` form a generic key-value lookup table...

<details>
<summary><code>381.sql</code> — new file</summary>

` ``diff
+CREATE TABLE stats_dimensions (
+  id          BIGSERIAL PRIMARY KEY,
+  code        TEXT NOT NULL UNIQUE,
...
` ``

</details>

> **`Tables.scala`** — *diff not available (file too large or failed to load)*
```

## Architecture

```
graphite-tour-export/
  manifest.json           # Manifest V3 — permissions: activeTab, storage
  content-graphite.js     # Core extraction logic (621 lines)
  content-github.js       # GitHub PR comment filler (79 lines)
  popup.html / popup.js   # Extension popup UI
  icons/                  # 16/48/128px PNG icons
```

### manifest.json

Manifest V3. Content scripts inject on `app.graphite.com` (extraction) and `github.com` (comment filling). Permissions: `activeTab` for clipboard access, `storage` for passing data between tabs.

### content-graphite.js

The core of the extension. Handles everything in a single async forward pass (`extractTourWithScroll`):

1. **Walks the tour column** — Graphite renders the tour as a flat list of alternating context blocks (`div.CodeTourContextBlock_context__*`) and file cards (`div.FileCard_file__*`). Context blocks contain the narrative; file cards contain the diffs.

2. **Extracts narrative** — Context blocks contain standard semantic HTML (`<h2>`, `<p>`, `<code>`, `<strong>`, `<ul>`, `<ol>`) inside a `div.markdown_markdown__*`. The extension converts this to markdown, preserving inline code, bold, lists, and links. A single context block can contain multiple headings (h2 + nested h3s), which get split into separate sections.

3. **Scrolls and harvests diffs** — For each file card, smooth-scrolls it into view using `smoothScrollToCard` (re-checks position each 80px step to handle DOM layout shifts from Graphite's virtual renderer). Then progressively harvests diff lines as it scrolls through the card, deduplicating by `side:lineNum` key in a Map. This handles Graphite's virtualized rendering where only viewport-visible lines exist in the DOM at any moment.

4. **Detects +/-/context** — Uses the **gutter inner div's** CSS classes (`line_side_number__added__*`, `line_side_number__deleted__*`) rather than the content div's classes, which are unreliable on modification hunks.

5. **Preserves DOM order** — Graphite's DOM already presents lines in correct unified diff order (deletions interleaved at the right positions relative to context and additions). The extension preserves this order rather than re-sorting by line number.

6. **Splits hunks** — Detects gaps in RIGHT-side line numbers and emits separate ` ```diff ` blocks for each hunk within the same `<details>` element.

### content-github.js

Listens for markdown stored in `chrome.storage.local` by the popup. When found on a `github.com` page, fills the PR comment textarea and dispatches input events so GitHub's JS picks up the change. Also listens for `storage.onChanged` in case the data arrives after page load.

### popup.html / popup.js

Minimal popup with two buttons and a status line. Checks if the current tab is a Graphite tour page (via URL pattern + DOM check). Sends `extract` messages to the content script and displays progress updates. For the GitHub flow, stores the markdown in `chrome.storage.local` and opens the PR page in a new tab.

## How diff extraction works

Graphite uses a **virtualized renderer** for diff lines — only lines visible in the viewport exist in the DOM. This creates several challenges:

1. **Cards start with 1 placeholder line** until scrolled into view. The extension smooth-scrolls each card into the viewport and waits up to 3 seconds for lines to populate.

2. **Tall cards don't render all lines at once.** The extension scrolls through the card in 40%-viewport steps, harvesting rendered lines at each stop. Lines are accumulated in a Map keyed by `${side}:${lineNum}`, so overlapping harvests are deduplicated.

3. **Lines de-render when scrolled past.** This is why extraction happens inline during the scroll — each card's lines are captured while it's in the viewport, before moving to the next card.

4. **DOM layout shifts during scrolling.** As cards load/unload, absolute positions change. `smoothScrollToCard` re-reads `getBoundingClientRect()` on every 80px step instead of pre-computing a scroll delta.

5. **CSS classes are unreliable for +/-.** The content div's `added`/`deleted` classes are missing on some modification lines. The gutter inner div's classes are reliable on every line.

6. **Some cards never finish loading** (e.g., large generated files). These time out after 3 seconds and produce a tombstone in the output.

## Known limitations

- **Selector fragility**: The extension uses Graphite's CSS module class name prefixes (e.g., `CodeTourContextBlock_context__`, `FileCard_file__`, `FileDiffLines_fileDiffLines__`). These are stable within a deploy but could change when Graphite updates their frontend.

- **GitHub comment size limit**: GitHub PR comments max out at 65,536 characters. Large tours may exceed this — the popup warns and suggests using clipboard instead.

- **Extraction speed**: Progressive scrolling takes 30-90 seconds for a large PR. This is the cost of working around virtualized rendering.

- **Very large generated files** (like `Tables.scala` with thousands of lines) may time out and show a tombstone instead of the full diff.

## Future ideas

- Download as `.md` file directly
- Configurable: include/exclude diffs, include/exclude specific sections
- Better icons (current ones are simple orange "T" placeholders)
- Publish to Chrome Web Store

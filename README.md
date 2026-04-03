# Graphite Tour Export

Chrome extension that exports Graphite PR Tour content as portable Markdown.

## Features

- **Copy as Markdown** — extract the full tour (narrative + diffs) to your clipboard
- **Comment on GitHub PR** — pre-fill a GitHub PR comment with the tour content wrapped in a `<details>` block

## Install

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this directory

## Usage

1. Open a PR on [Graphite](https://app.graphite.com) and switch to **Tour** mode
2. Click the extension icon in the toolbar
3. Choose **Copy as Markdown** or **Comment on GitHub PR**

## How it works

The extension injects a content script on `app.graphite.com` that:

1. Scrolls the page to trigger lazy-loaded content
2. Expands collapsed diff sections
3. Walks the DOM to extract section headings, narrative prose, and code diffs
4. Assembles everything into Markdown with unified diff format

For the GitHub comment flow, a second content script on `github.com` picks up the extracted markdown and fills the PR comment textarea.

// content-graphite.js — Extracts Graphite PR Tour content as Markdown

(() => {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(predicate, { timeout = 10000, interval = 200 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate()) return true;
      await sleep(interval);
    }
    return false;
  }

  function findScrollableAncestor(el) {
    while (el && el !== document.documentElement) {
      el = el.parentElement;
      if (!el) break;
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight
      ) {
        return el;
      }
    }
    return null;
  }

  function parsePrFromUrl() {
    const match = window.location.href.match(
      /app\.graphite\.com\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)/
    );
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: match[3] };
  }

  function getPrTitle() {
    // The title is in the header area, after "#NNNN "
    const headerText = document.title.replace(/ - Graphite$/, "").trim();
    // Title format: "#5802 (Evolution) Census Ledger Skeleton - Graphite"
    return headerText.replace(/^#\d+\s*/, "");
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Prepare the page — expand collapsed sections, trigger lazy loads
  // ---------------------------------------------------------------------------

  // Pre-extracted diff data, keyed by the card's index within the tour column.
  // Using index (not element ref) because Graphite may re-render DOM elements
  // during scrolling, invalidating WeakMap references.
  const cardDiffCache = new Map();

  async function smoothScrollBy(container, pixels) {
    const STEP = 80;
    const DELAY = 40;
    const direction = pixels > 0 ? 1 : -1;
    let remaining = Math.abs(pixels);
    while (remaining > 0) {
      const chunk = Math.min(remaining, STEP);
      container.scrollTop += direction * chunk;
      remaining -= chunk;
      await sleep(DELAY);
    }
  }

  function harvestLines(card) {
    // Read whatever diff lines are currently rendered in this card.
    // Returns an array of { key, prefix, text, lineNum, side }.
    const container = card.querySelector(
      '[class*="FileDiffLines_fileDiffLines__"]'
    );
    if (!container) return [];

    const result = [];
    for (const lineEl of container.children) {
      const contentDiv = lineEl.querySelector(
        '[class*="DiffHighlighting_line_side__"]'
      );
      if (!contentDiv) continue;

      const codeDiv = contentDiv.querySelector(
        '[class*="CodeLineHtml_codeLineHtml__"]'
      );
      if (!codeDiv) continue; // placeholder — not rendered yet

      const isAdded = contentDiv.className.includes("added");
      const isDeleted = contentDiv.className.includes("deleted");
      const prefix = isAdded ? "+" : isDeleted ? "-" : " ";

      const gutter = lineEl.querySelector("[data-gutter-line-number]");
      const lineNum = gutter
        ? parseInt(gutter.getAttribute("data-gutter-line-number"), 10)
        : null;
      const side = gutter?.getAttribute("data-side") || null;

      result.push({
        key: `${side}:${lineNum}`,
        prefix,
        text: codeDiv.textContent ?? "",
        lineNum,
        side,
      });
    }
    return result;
  }

  async function preparePage(onProgress) {
    // Strategy: smooth-scroll through each file card from top to bottom,
    // harvesting rendered diff lines at each viewport position. Lines are
    // deduped by key (side + lineNum) so we accumulate the complete set
    // even though only a viewport's worth are rendered at any moment.

    const scrollContainer = findScrollableAncestor(
      document.querySelector('[class*="CodeDiff_diffStepsColumn__"]')
    );
    if (!scrollContainer) return;

    const tourColumn = document.querySelector(
      '[class*="CodeDiff_diffStepsColumn__"]'
    );
    if (!tourColumn) return;

    scrollContainer.scrollTop = 0;
    await sleep(300);

    const allChildren = [...tourColumn.children];
    const fileCardEntries = allChildren
      .map((el, idx) => [idx, el])
      .filter(([, el]) => el.matches?.('[class*="FileCard_file__"]'));
    const total = fileCardEntries.length;

    for (let i = 0; i < total; i++) {
      onProgress?.(`Rendering diffs... (${i + 1}/${total})`);
      const [childIndex, card] = fileCardEntries[i];

      // ── Scroll so the top of this card is near the top of the viewport ──
      const containerRect = scrollContainer.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const desiredScrollTop =
        scrollContainer.scrollTop +
        (cardRect.top - containerRect.top) -
        30;
      await smoothScrollBy(
        scrollContainer,
        desiredScrollTop - scrollContainer.scrollTop
      );
      await sleep(400);

      // ── Wait for initial render ──
      const hasLoading = card.querySelector('img[alt="Loading..."]') !== null;
      if (hasLoading) {
        const loaded = await waitFor(
          () => card.querySelector('img[alt="Loading..."]') === null,
          { timeout: 3000, interval: 200 }
        );
        if (!loaded) {
          // Card never loaded — cache empty result and move on
          cardDiffCache.set(childIndex, extractDiffCardHeader(card));
          continue;
        }
      }

      const diffLines = card.querySelector(
        '[class*="FileDiffLines_fileDiffLines__"]'
      );
      if (diffLines) {
        await waitFor(() => diffLines.children.length > 1, {
          timeout: 3000,
          interval: 100,
        });
        await sleep(200);
      }

      // ── Expand any "N lines" context-collapse buttons ──
      const expandBtns = [...card.querySelectorAll("button")].filter((b) =>
        /^\d+ lines?$/.test(b.textContent?.trim())
      );
      for (const btn of expandBtns) {
        btn.click();
        await sleep(200);
      }
      if (expandBtns.length > 0) await sleep(500);

      // ── Progressive harvest: scroll through the card, collecting lines ──
      const lineMap = new Map();

      // Harvest the initial viewport
      for (const l of harvestLines(card)) lineMap.set(l.key, l);

      // Scroll through tall cards in half-viewport steps
      if (diffLines) {
        const updatedRect = card.getBoundingClientRect();
        const viewH = scrollContainer.clientHeight;

        if (updatedRect.height > viewH * 0.5) {
          const stepPx = Math.floor(viewH * 0.4);
          const steps = Math.ceil(updatedRect.height / stepPx);
          for (let s = 0; s < steps; s++) {
            await smoothScrollBy(scrollContainer, stepPx);
            await sleep(300);
            for (const l of harvestLines(card)) lineMap.set(l.key, l);
          }
        }
      }

      // Sort lines by line number
      const sorted = [...lineMap.values()].sort((a, b) => {
        if (a.lineNum == null || b.lineNum == null) return 0;
        return a.lineNum - b.lineNum;
      });

      // Build the cached result with header info + harvested lines
      const header = extractDiffCardHeader(card);
      header.lines = sorted;
      cardDiffCache.set(childIndex, header);
    }
  }

  function extractDiffCardHeader(card) {
    const titleBtn = card.querySelector(
      '[class*="FileDiffTitle_fileDiffTitle__"]'
    );
    const langBtn = card.querySelector(
      '[class*="LanguageSelector_languageSelectorButton__"]'
    );
    const headerEl = card.querySelector('[class*="FileHeader_fileHeader__"]');
    const headerText = headerEl?.textContent || "";
    const lineRangeMatch = headerText.match(/Lines?\s+(\d+[–\-]\d+|\d+)/);
    return {
      filePath: titleBtn?.textContent?.trim() || "unknown",
      language: langBtn?.textContent?.trim() || "",
      isNew: headerText.includes("Created"),
      lineRange: lineRangeMatch ? lineRangeMatch[0] : null,
      lines: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Extract the tour structure from the DOM
  // ---------------------------------------------------------------------------

  function extractTour() {
    const pr = parsePrFromUrl();
    const prTitle = getPrTitle();

    // The tour is a flat list of alternating context blocks and file cards
    const tourColumn = document.querySelector(
      '[class*="CodeDiff_diffStepsColumn__"]'
    );
    if (!tourColumn) return null;

    const children = [...tourColumn.children];
    const sections = [];
    let currentSection = null;

    for (let ci = 0; ci < children.length; ci++) {
      const child = children[ci];
      const isContext = child.matches?.('[class*="CodeTourContextBlock_context__"]');
      const isFileCard = child.matches?.('[class*="FileCard_file__"]');

      if (isContext) {
        const markdownDiv = child.querySelector('[class*="markdown_markdown__"]');
        if (!markdownDiv) continue;

        // A single context block can contain multiple headings (h2 + nested h3s).
        // Split it into sub-sections by walking children and splitting on headings.
        const headings = [...markdownDiv.querySelectorAll("h2, h3")];

        if (headings.length > 0) {
          // Process each heading and the content between it and the next heading
          for (let hi = 0; hi < headings.length; hi++) {
            const heading = headings[hi];
            const anchor = heading.querySelector("a[href^='#']");
            const slug = anchor?.getAttribute("href")?.slice(1) || "";
            currentSection = {
              slug,
              title: heading.textContent.trim(),
              level: heading.tagName === "H2" ? 2 : 3,
              narrative: "",
              diffs: [],
            };
            sections.push(currentSection);

            // Collect elements between this heading and the next
            const nextHeading = headings[hi + 1] || null;
            currentSection.narrative = extractNarrativeBetween(
              markdownDiv,
              heading,
              nextHeading
            );
          }
        } else if (currentSection) {
          // Continuation of narrative in the same section (no heading)
          const text = extractNarrative(markdownDiv, null);
          if (text) {
            currentSection.narrative += "\n\n" + text;
          }
        }
      } else if (isFileCard && currentSection) {
        // Use cached extraction from preparePage (keyed by child index)
        const diff = cardDiffCache.get(ci) || extractDiffCard(child);
        if (diff) {
          currentSection.diffs.push(diff);
        }
      }
    }

    return { pr, prTitle, sections };
  }

  // ---------------------------------------------------------------------------
  // Narrative extraction — convert HTML to Markdown
  // ---------------------------------------------------------------------------

  function extractNarrative(markdownDiv, skipHeading) {
    const parts = [];

    for (const node of markdownDiv.children) {
      // Skip the heading we already captured
      if (node === skipHeading) continue;
      // Skip feedback buttons
      if (node.matches?.('[class*="feedbackButtons"]')) continue;
      // Skip file stats (the "N files +M" line)
      if (isFileStatsElement(node)) continue;

      const md = htmlToMarkdown(node);
      if (md.trim()) parts.push(md.trim());
    }

    return parts.join("\n\n");
  }

  function extractNarrativeBetween(markdownDiv, afterHeading, beforeHeading) {
    const parts = [];
    let collecting = false;

    for (const node of markdownDiv.children) {
      if (node === afterHeading) {
        collecting = true;
        continue;
      }
      if (node === beforeHeading) break;
      if (!collecting) continue;

      // Skip feedback buttons and file stats
      if (node.matches?.('[class*="feedbackButtons"]')) continue;
      if (isFileStatsElement(node)) continue;
      // Skip other headings (shouldn't happen but be safe)
      if (node.tagName === "H2" || node.tagName === "H3") continue;

      const md = htmlToMarkdown(node);
      if (md.trim()) parts.push(md.trim());
    }

    return parts.join("\n\n");
  }

  function isFileStatsElement(el) {
    const text = el.textContent?.trim() || "";
    return /^\d+ files?\s*\+\d+/.test(text);
  }

  function htmlToMarkdown(el) {
    if (el.nodeType === Node.TEXT_NODE) {
      return el.textContent || "";
    }

    const tag = el.tagName;

    if (tag === "P") return inlineToMarkdown(el);
    if (tag === "H2") return "## " + el.textContent.trim();
    if (tag === "H3") return "### " + el.textContent.trim();

    if (tag === "UL") {
      return [...el.children]
        .map((li) => "- " + inlineToMarkdown(li))
        .join("\n");
    }
    if (tag === "OL") {
      return [...el.children]
        .map((li, i) => `${i + 1}. ` + inlineToMarkdown(li))
        .join("\n");
    }

    if (tag === "BLOCKQUOTE") {
      return el.textContent
        .trim()
        .split("\n")
        .map((l) => "> " + l)
        .join("\n");
    }

    if (tag === "PRE") {
      const code = el.querySelector("code");
      return "```\n" + (code || el).textContent + "\n```";
    }

    // Default: just get inline content
    return inlineToMarkdown(el);
  }

  function inlineToMarkdown(el) {
    let result = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
      } else if (node.tagName === "CODE") {
        result += "`" + node.textContent + "`";
      } else if (node.tagName === "STRONG" || node.tagName === "B") {
        result += "**" + node.textContent + "**";
      } else if (node.tagName === "EM" || node.tagName === "I") {
        result += "*" + node.textContent + "*";
      } else if (node.tagName === "A") {
        result += "[" + node.textContent + "](" + node.href + ")";
      } else if (node.tagName === "BR") {
        result += "\n";
      } else {
        // Recurse for nested elements
        result += inlineToMarkdown(node);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Diff card extraction
  // ---------------------------------------------------------------------------

  function extractDiffCard(card) {
    // File path from the title button
    const titleBtn = card.querySelector(
      '[class*="FileDiffTitle_fileDiffTitle__"]'
    );
    const filePath = titleBtn?.textContent?.trim() || "unknown";

    // Language
    const langBtn = card.querySelector(
      '[class*="LanguageSelector_languageSelectorButton__"]'
    );
    const language = langBtn?.textContent?.trim() || "";

    // Detect "Created" (new file) vs line range
    const headerEl = card.querySelector('[class*="FileHeader_fileHeader__"]');
    const headerText = headerEl?.textContent || "";
    const isNew = headerText.includes("Created");

    // Extract line range if present (e.g., "Lines 117–174")
    const lineRangeMatch = headerText.match(/Lines?\s+(\d+[–\-]\d+|\d+)/);
    const lineRange = lineRangeMatch ? lineRangeMatch[0] : null;

    // Extract diff lines with line numbers
    const diffLinesContainer = card.querySelector(
      '[class*="FileDiffLines_fileDiffLines__"]'
    );
    const lines = [];

    if (diffLinesContainer) {
      for (const lineEl of diffLinesContainer.children) {
        const contentDiv = lineEl.querySelector(
          '[class*="DiffHighlighting_line_side__"]'
        );
        if (!contentDiv) continue;

        const isAdded = contentDiv.className.includes("added");
        const isDeleted = contentDiv.className.includes("deleted");
        const prefix = isAdded ? "+" : isDeleted ? "-" : " ";

        // Line number from the gutter's data attribute
        const gutter = lineEl.querySelector("[data-gutter-line-number]");
        const lineNum = gutter
          ? parseInt(gutter.getAttribute("data-gutter-line-number"), 10)
          : null;
        const side = gutter?.getAttribute("data-side") || null;

        // Get the code text from the CodeLineHtml div
        const codeDiv = contentDiv.querySelector(
          '[class*="CodeLineHtml_codeLineHtml__"]'
        );
        const text = codeDiv?.textContent || contentDiv.textContent || "";

        lines.push({ prefix, text, lineNum, side });
      }
    }

    return { filePath, language, isNew, lineRange, lines };
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Assemble Markdown
  // ---------------------------------------------------------------------------

  function toMarkdown({ pr, prTitle, sections }) {
    const out = [];

    // Header
    out.push(`# ${prTitle} (#${pr.number})`);
    out.push("");
    out.push(
      `> Exported from [Graphite Tour](https://app.graphite.com/github/pr/${pr.owner}/${pr.repo}/${pr.number}?mode=tour)`
    );
    out.push("");

    // TOC
    out.push("## Table of Contents");
    out.push("");
    for (const section of sections) {
      const indent = section.level === 3 ? "  " : "";
      out.push(`${indent}- [${section.title}](#${section.slug})`);
    }
    out.push("");

    // Sections
    for (const section of sections) {
      const hashes = "#".repeat(section.level);
      out.push(`${hashes} ${section.title}`);
      out.push("");

      if (section.narrative) {
        out.push(section.narrative);
        out.push("");
      }

      for (const diff of section.diffs) {
        if (diff.lines.length === 0) continue;

        // Build the unified diff header
        const aPath = diff.isNew ? "/dev/null" : `a/${diff.filePath}`;
        const bPath = `b/${diff.filePath}`;
        const hunkHeader = buildHunkHeader(diff);

        // Short label for the <summary>
        const shortName = diff.filePath.split("/").pop();
        const annotation = diff.lineRange
          ? ` (${diff.lineRange})`
          : diff.isNew
            ? " — new file"
            : "";

        out.push(`<details>`);
        out.push(`<summary><code>${shortName}</code>${annotation}</summary>`);
        out.push("");
        out.push("```diff");
        out.push(`--- ${aPath}`);
        out.push(`+++ ${bPath}`);
        out.push(hunkHeader);
        for (const line of diff.lines) {
          out.push(`${line.prefix}${line.text}`);
        }
        out.push("```");
        out.push("");
        out.push("</details>");
        out.push("");
      }
    }

    return out.join("\n");
  }

  function buildHunkHeader(diff) {
    const added = diff.lines.filter((l) => l.prefix === "+").length;
    const deleted = diff.lines.filter((l) => l.prefix === "-").length;
    const context = diff.lines.filter((l) => l.prefix === " ").length;

    if (diff.isNew) {
      return `@@ -0,0 +1,${added} @@`;
    }

    // Derive line numbers from the first line with a number
    const firstLine = diff.lines.find((l) => l.lineNum != null);
    const startLine = firstLine?.lineNum || 1;

    const oldCount = deleted + context;
    const newCount = added + context;
    const oldStart = oldCount > 0 ? startLine : 0;
    const newStart = newCount > 0 ? startLine : 0;

    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  }

  // ---------------------------------------------------------------------------
  // Message handler — popup sends messages, we respond
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "extract") {
      handleExtract(message, sendResponse);
      return true; // async response
    }
    if (message.action === "ping") {
      sendResponse({ ok: true, isTourPage: isTourPage() });
      return false;
    }
  });

  function isTourPage() {
    return /app\.graphite\.com\/github\/pr\/.+/.test(window.location.href)
      && document.querySelector('[class*="CodeDiff_diffStepsColumn__"]') !== null;
  }

  async function handleExtract(message, sendResponse) {
    try {
      await preparePage((status) => {
        chrome.runtime.sendMessage({ type: "progress", status });
      });

      const tour = extractTour();
      if (!tour) {
        sendResponse({ error: "Could not find tour content on this page." });
        return;
      }

      const markdown = toMarkdown(tour);

      sendResponse({
        markdown,
        pr: tour.pr,
        charCount: markdown.length,
      });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }
})();

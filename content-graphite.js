// content-graphite.js — Extracts Graphite PR Tour content as Markdown

(() => {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function sha256Hex(str) {
    const encoded = new TextEncoder().encode(str);
    const buffer = await crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

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

  async function smoothScrollToCard(scrollContainer, card) {
    // Scroll in small steps, re-checking the card's position each step.
    // Immune to DOM layout shifts from Graphite's virtual renderer.
    const STEP = 80;
    const DELAY = 40;
    const MAX_STEPS = 500;
    const TARGET_OFFSET = 30;

    for (let i = 0; i < MAX_STEPS; i++) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const distance = (cardRect.top - containerRect.top) - TARGET_OFFSET;

      if (Math.abs(distance) < STEP) {
        scrollContainer.scrollTop += distance;
        await sleep(DELAY);
        break;
      }

      scrollContainer.scrollTop += (distance > 0 ? 1 : -1) * STEP;
      await sleep(DELAY);
    }

    await sleep(200);
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

      const gutter = lineEl.querySelector("[data-gutter-line-number]");
      const lineNum = gutter
        ? parseInt(gutter.getAttribute("data-gutter-line-number"), 10)
        : null;
      const side = gutter?.getAttribute("data-side") || null;

      // The gutter's inner div has reliable added/deleted classes,
      // unlike the content div which omits them on some lines.
      const gutterInner = gutter?.querySelector(
        '[class*="line_side_number__"]'
      );
      const gutterClass = gutterInner?.className || "";
      const isAdded = gutterClass.includes("added");
      const isDeleted = gutterClass.includes("deleted");

      const prefix = isAdded ? "+" : isDeleted ? "-" : " ";

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

  // ---------------------------------------------------------------------------
  // Single-pass extraction: walk the tour column, extracting narrative from
  // context blocks (no scroll needed) and scrolling+harvesting each file card
  // in place. This avoids all index/cache coherency problems because we never
  // revisit a card after scrolling past it.
  // ---------------------------------------------------------------------------

  async function extractTourWithScroll(onProgress) {
    const pr = parsePrFromUrl();
    const prTitle = getPrTitle();

    const tourColumn = document.querySelector(
      '[class*="CodeDiff_diffStepsColumn__"]'
    );
    if (!tourColumn) return null;

    const scrollContainer = findScrollableAncestor(tourColumn);
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
      await sleep(300);
    }

    const children = [...tourColumn.children];
    const sections = [];
    let currentSection = null;
    let cardNumber = 0;
    const totalCards = children.filter((c) =>
      c.matches?.('[class*="FileCard_file__"]')
    ).length;

    for (const child of children) {
      const isContext = child.matches?.(
        '[class*="CodeTourContextBlock_context__"]'
      );
      const isFileCard = child.matches?.('[class*="FileCard_file__"]');

      if (isContext) {
        const markdownDiv = child.querySelector(
          '[class*="markdown_markdown__"]'
        );
        if (!markdownDiv) continue;

        const headings = [...markdownDiv.querySelectorAll("h2, h3")];

        if (headings.length > 0) {
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

            const nextHeading = headings[hi + 1] || null;
            currentSection.narrative = extractNarrativeBetween(
              markdownDiv,
              heading,
              nextHeading
            );
          }
        } else if (currentSection) {
          const text = extractNarrative(markdownDiv, null);
          if (text) {
            currentSection.narrative += "\n\n" + text;
          }
        }
      } else if (isFileCard && currentSection) {
        cardNumber++;
        onProgress?.(`Rendering diffs... (${cardNumber}/${totalCards})`);

        const diff = scrollContainer
          ? await scrollAndHarvestCard(scrollContainer, child)
          : extractDiffCard(child);

        if (diff) {
          currentSection.diffs.push(diff);
        }
      }
    }

    return { pr, prTitle, sections };
  }

  async function scrollAndHarvestCard(scrollContainer, card) {
    // Scroll the card into view
    await smoothScrollToCard(scrollContainer, card);

    // Wait for content to render
    const hasLoading = card.querySelector('img[alt="Loading..."]') !== null;
    if (hasLoading) {
      const loaded = await waitFor(
        () => card.querySelector('img[alt="Loading..."]') === null,
        { timeout: 3000, interval: 200 }
      );
      if (!loaded) return extractDiffCard(card); // give up, take what's there
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



    // Extract header info
    const titleBtn = card.querySelector(
      '[class*="FileDiffTitle_fileDiffTitle__"]'
    );
    const langBtn = card.querySelector(
      '[class*="LanguageSelector_languageSelectorButton__"]'
    );
    const headerEl = card.querySelector('[class*="FileHeader_fileHeader__"]');
    const headerText = headerEl?.textContent || "";
    const lineRangeMatch = headerText.match(/Lines?\s+(\d+[–\-]\d+|\d+)/);

    const result = {
      filePath: titleBtn?.textContent?.trim() || "unknown",
      language: langBtn?.textContent?.trim() || "",
      isNew: headerText.includes("Created"),
      lineRange: lineRangeMatch ? lineRangeMatch[0] : null,
      lines: [],
    };

    // Progressive harvest — collect lines as we scroll through the card
    const lineMap = new Map();
    for (const l of harvestLines(card)) lineMap.set(l.key, l);

    if (diffLines) {
      const viewH = scrollContainer.clientHeight;
      const stepPx = Math.floor(viewH * 0.4);
      let prevCount = lineMap.size;
      let staleStops = 0;

      for (let s = 0; s < 200; s++) {
        const cRect = card.getBoundingClientRect();
        const sRect = scrollContainer.getBoundingClientRect();
        const cardBottom = cRect.bottom - sRect.top;

        if (cardBottom < viewH * 0.3) break;

        scrollContainer.scrollTop += stepPx;
        await sleep(250);
        for (const l of harvestLines(card)) lineMap.set(l.key, l);

        if (lineMap.size === prevCount) {
          staleStops++;
          if (staleStops >= 2) break;
        } else {
          staleStops = 0;
          prevCount = lineMap.size;
        }
      }
    }

    // Sort: LEFT lines before RIGHT lines at the same line number,
    // then by line number. This puts deletions before their replacements.
    // Lines are in correct unified diff order from DOM traversal.
    // Map preserves insertion order, so no sorting needed.
    result.lines = [...lineMap.values()];
    return result;
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

  async function toMarkdown({ pr, prTitle, sections }) {
    const out = [];

    // Header
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
        const shortName = diff.filePath.split("/").pop();
        const fileHash = await sha256Hex(diff.filePath);
        const ghDiffLink = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}/files#diff-${fileHash}`;

        if (diff.lines.length === 0) {
          out.push(
            `> [**\`${shortName}\`**](${ghDiffLink}) — *diff not available (file too large or failed to load)*`
          );
          out.push("");
          continue;
        }

        const hunks = splitIntoHunks(diff.lines);

        const annotation = diff.lineRange
          ? ` (${diff.lineRange})`
          : diff.isNew
            ? " — new file"
            : "";

        // New files with only additions: render as the actual language
        // without +/- prefixes for proper syntax highlighting.
        const allAdded = diff.lines.every((l) => l.prefix === "+");

        out.push(`<details>`);
        out.push(`<summary><a href="${ghDiffLink}" target="_blank"><code>${shortName}</code></a>${annotation}</summary>`);
        out.push("");
        if (allAdded) {
          const lang = fenceLang(diff.language);
          out.push("```" + lang);
          for (const line of diff.lines) {
            out.push(line.text);
          }
          out.push("```");
        } else {
          for (let hi = 0; hi < hunks.length; hi++) {
            if (hi > 0) out.push(""); // blank line between hunks
            out.push("```diff");
            for (const line of hunks[hi]) {
              out.push(`${line.prefix}${line.text}`);
            }
            out.push("```");
          }
        }
        out.push("");
        out.push("</details>");
        out.push("");
      }
    }

    return out.join("\n");
  }


  function fenceLang(graphiteLang) {
    const map = {
      Scala: "scala",
      SQL: "sql",
      Java: "java",
      Kotlin: "kotlin",
      JavaScript: "js",
      TypeScript: "ts",
      Python: "python",
      Go: "go",
      Rust: "rust",
      Ruby: "ruby",
      "Protocol Buffers": "protobuf",
      Shell: "bash",
      YAML: "yaml",
      JSON: "json",
      TOML: "toml",
      XML: "xml",
      HTML: "html",
      CSS: "css",
      Markdown: "md",
      txt: "text",
    };
    return map[graphiteLang] || graphiteLang?.toLowerCase() || "";
  }

  function splitIntoHunks(lines) {
    // Split a sorted line array into separate hunks wherever there's a gap
    // in RIGHT-side line numbers (> 1 jump). LEFT-side lines (deletions)
    // use old line numbers and don't affect gap detection.
    if (lines.length === 0) return [];

    const hunks = [[]];
    let lastRightLineNum = null;

    for (const line of lines) {
      if (line.side === "RIGHT" && line.lineNum != null) {
        if (
          lastRightLineNum != null &&
          line.lineNum - lastRightLineNum > 1
        ) {
          hunks.push([]);
        }
        lastRightLineNum = line.lineNum;
      }
      hunks[hunks.length - 1].push(line);
    }

    return hunks;
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
      const onProgress = (status) => {
        chrome.runtime.sendMessage({ type: "progress", status });
      };

      const tour = await extractTourWithScroll(onProgress);
      if (!tour) {
        sendResponse({ error: "Could not find tour content on this page." });
        return;
      }

      onProgress("Assembling markdown...");
      const markdown = await toMarkdown(tour);

      onProgress("Sending to popup...");
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

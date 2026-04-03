// popup.js — Extension popup logic

const copyBtn = document.getElementById("copyBtn");
const githubBtn = document.getElementById("githubBtn");
const statusEl = document.getElementById("status");
const contentEl = document.getElementById("content");
const notTourEl = document.getElementById("notTour");

function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = type;
}

function setEnabled(enabled) {
  copyBtn.disabled = !enabled;
  githubBtn.disabled = !enabled;
}

// Check if current tab is a Graphite tour page
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const isGraphite = /app\.graphite\.com\/github\/pr\//.test(tab.url);
  if (!isGraphite) {
    contentEl.style.display = "none";
    notTourEl.style.display = "block";
    return;
  }

  // Ping the content script to verify it's loaded and the tour is present
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "ping" });
    if (!response?.isTourPage) {
      setStatus("Switch to Tour mode to export.", "error");
      setEnabled(false);
      return;
    }
  } catch {
    // Content script not loaded yet — might need a page refresh
    setStatus("Reload the page and try again.", "error");
    setEnabled(false);
    return;
  }

  setStatus("Ready");
}

// Listen for progress updates from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "progress") {
    setStatus(message.status);
  }
});

// Copy as Markdown
copyBtn.addEventListener("click", async () => {
  setEnabled(false);
  setStatus("Extracting tour...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { action: "extract" });

    if (result.error) {
      setStatus(result.error, "error");
      setEnabled(true);
      return;
    }

    await navigator.clipboard.writeText(result.markdown);
    const kb = Math.round(result.charCount / 1024);
    setStatus(`Copied! (${kb} KB)`, "success");
  } catch (err) {
    setStatus("Extraction failed: " + err.message, "error");
  }

  setEnabled(true);
});

// Comment on GitHub PR
githubBtn.addEventListener("click", async () => {
  setEnabled(false);
  setStatus("Extracting tour...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { action: "extract" });

    if (result.error) {
      setStatus(result.error, "error");
      setEnabled(true);
      return;
    }

    // Check GitHub comment size limit (65536 chars)
    if (result.markdown.length > 65536) {
      setStatus(
        `Too large for GitHub comment (${Math.round(result.markdown.length / 1024)} KB > 64 KB). Use clipboard instead.`,
        "error"
      );
      setEnabled(true);
      return;
    }

    // Store markdown for the GitHub content script to pick up
    const { owner, repo, number } = result.pr;
    await chrome.storage.local.set({
      pendingComment: result.markdown,
      pendingPr: { owner, repo, number },
    });

    // Open GitHub PR page
    const ghUrl = `https://github.com/${owner}/${repo}/pull/${number}`;
    await chrome.tabs.create({ url: ghUrl });

    setStatus("Opened GitHub PR — comment will be pre-filled.", "success");
  } catch (err) {
    setStatus("Failed: " + err.message, "error");
  }

  setEnabled(true);
});

init();

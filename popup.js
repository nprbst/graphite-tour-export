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

    setStatus("Copying to clipboard...");
    await navigator.clipboard.writeText(result.markdown);
    const kb = Math.round(result.charCount / 1024);
    setStatus(`Copied! (${kb} KB)`, "success");
  } catch (err) {
    setStatus("Extraction failed: " + err.message, "error");
  }

  setEnabled(true);
});

// Post as discussion comment
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

    setStatus("Filling discussion comment...");

    const fillResult = await chrome.tabs.sendMessage(tab.id, {
      action: "fill-comment",
      markdown: result.markdown,
    });

    if (fillResult.error) {
      setStatus(fillResult.error, "error");
      setEnabled(true);
      return;
    }

    const kb = Math.round(result.charCount / 1024);
    if (fillResult.posted) {
      setStatus(`Posted! (${kb} KB)`, "success");
    } else {
      setStatus(`Comment filled (${kb} KB) — click Post to submit.`, "success");
    }
  } catch (err) {
    setStatus("Failed: " + err.message, "error");
  }

  setEnabled(true);
});

init();

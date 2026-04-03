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

// Send an action to the content script via a port so we can receive
// progress updates without the popup's event loop blocking on await.
function sendAction(tabId, action) {
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: "tour-export" });

    port.onMessage.addListener((msg) => {
      if (msg.type === "progress") {
        setStatus(msg.status);
      } else if (msg.type === "result") {
        resolve(msg.data);
        port.disconnect();
      } else if (msg.type === "error") {
        reject(new Error(msg.message));
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      }
    });

    port.postMessage({ action });
  });
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

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "ping" });
    if (!response?.isTourPage) {
      setStatus("Switch to Tour mode to export.", "error");
      setEnabled(false);
      return;
    }
  } catch {
    setStatus("Reload the page and try again.", "error");
    setEnabled(false);
    return;
  }

  setStatus("Ready");
}

// Copy as Markdown
copyBtn.addEventListener("click", async () => {
  setEnabled(false);
  setStatus("Extracting tour...");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const result = await sendAction(tab.id, "extract");

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
    const result = await sendAction(tab.id, "extract-and-post");

    if (result.error) {
      setStatus(result.error, "error");
      setEnabled(true);
      return;
    }

    const kb = Math.round(result.charCount / 1024);
    if (result.posted) {
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

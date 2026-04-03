// content-github.js — Fills the GitHub PR comment box with tour markdown

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForElement(
    selector,
    { timeout = 10000, interval = 200 } = {}
  ) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(interval);
    }
    return null;
  }

  async function fillComment(markdown) {
    const wrapped = markdown;

    // Wait for the comment textarea to appear
    const textarea = await waitForElement(
      '#new_comment_field, textarea[name="comment[body]"]'
    );

    if (!textarea) {
      console.warn("[Graphite Tour Export] Could not find comment textarea.");
      return;
    }

    // Scroll to the comment area
    textarea.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(300);

    // Focus and fill — use native setter to work with React-controlled inputs
    textarea.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    ).set;
    nativeSetter.call(textarea, wrapped);

    // Dispatch events so GitHub's JS picks up the change
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));

    // GitHub's textarea auto-resizes
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  }

  async function checkAndFill() {
    try {
      const data = await chrome.storage.local.get([
        "pendingComment",
        "pendingPr",
      ]);
      if (!data.pendingComment) return;

      // Clear immediately so it doesn't fire on subsequent navigations
      await chrome.storage.local.remove(["pendingComment", "pendingPr"]);

      await fillComment(data.pendingComment);
    } catch (err) {
      console.error("[Graphite Tour Export]", err);
    }
  }

  // Check on load
  checkAndFill();

  // Also listen for storage changes in case the data arrives after load
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pendingComment?.newValue) {
      checkAndFill();
    }
  });
})();

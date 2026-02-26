const importSection = document.getElementById("import-section");
const resultDiv = document.getElementById("result");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const baseUrlInput = document.getElementById("base-url");
const saveUrlBtn = document.getElementById("save-url");
const pdfAutoOpenCheckbox = document.getElementById("pdf-auto-open");

let baseUrl = "http://localhost:3000";

// --- Init ---

async function init() {
  // Load settings
  const { baseUrl: stored, pdfAutoOpen } = await chrome.storage.sync.get({
    baseUrl: "http://localhost:3000",
    pdfAutoOpen: true,
  });
  baseUrl = stored;
  baseUrlInput.value = baseUrl;
  pdfAutoOpenCheckbox.checked = pdfAutoOpen;

  // Check health
  checkHealth();

  // Load history
  loadHistory();

  // Detect current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    await detectPage(tab);
  } else {
    showNoAction();
  }
}

async function detectPage(tab) {
  const url = tab.url || "";

  // Check for arXiv
  const arxivMatch = url.match(/arxiv\.org\/(abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  if (arxivMatch) {
    showArxivImport(arxivMatch[2], tab.title, url);
    return;
  }

  // Check for OpenReview
  const openReviewMatch = url.match(/openreview\.net\/(forum|pdf)\?.*id=([A-Za-z0-9_-]+)/);
  if (openReviewMatch) {
    showOpenReviewImport(openReviewMatch[2], tab.title, url);
    return;
  }

  // Check URL pathname for .pdf (handles hash fragments and query params)
  try {
    const urlObj = new URL(url);
    if (urlObj.pathname.toLowerCase().endsWith(".pdf")) {
      showPdfUpload(url);
      return;
    }
  } catch {
    // invalid URL, continue
  }

  // Fallback: check actual content type via scripting API
  // This catches PDFs served without .pdf in the URL (journals, repositories, etc.)
  if (tab.id) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.contentType,
      });
      if (result?.result === "application/pdf") {
        showPdfUpload(url);
        return;
      }
    } catch {
      // scripting may fail on restricted pages (chrome://, etc.)
    }
  }

  showNoAction();
}

function showArxivImport(arxivId, pageTitle, url) {
  // Clean up page title (arXiv titles often have prefix)
  const title = pageTitle
    ?.replace(/^\[\d{4}\.\d{4,5}(?:v\d+)?\]\s*/, "")
    .replace(/ - arXiv.*$/, "")
    .trim();

  importSection.innerHTML = `
    <div class="detect-label">arXiv Paper Detected</div>
    ${title ? `<div class="detect-title">${escapeHtml(title)}</div>` : ""}
    <div class="detect-id">ID: ${escapeHtml(arxivId)}</div>
    <button id="import-btn" class="btn btn-primary">Import to Arcana</button>
  `;

  document.getElementById("import-btn").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Importing…";

    const result = await chrome.runtime.sendMessage({
      type: "import-arxiv",
      input: url,
    });

    if (result.success) {
      btn.textContent = "✓ Imported";
      btn.style.background = "#16a34a";
      showResult(
        result.alreadyExists ? "warning" : "success",
        result.alreadyExists ? "Already in Arcana" : "Paper imported!",
        result.paper?.id
      );
    } else {
      btn.textContent = "Import to Arcana";
      btn.disabled = false;
      showResult("error", result.error || "Import failed");
    }

    loadHistory();
  });
}

function showOpenReviewImport(forumId, pageTitle, url) {
  // Clean up page title
  const title = pageTitle
    ?.replace(/ \| OpenReview$/, "")
    .trim();

  importSection.innerHTML = `
    <div class="detect-label">OpenReview Paper Detected</div>
    ${title ? `<div class="detect-title">${escapeHtml(title)}</div>` : ""}
    <div class="detect-id">ID: ${escapeHtml(forumId)}</div>
    <button id="import-btn" class="btn btn-primary">Import to Arcana</button>
  `;

  document.getElementById("import-btn").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Importing…";

    const result = await chrome.runtime.sendMessage({
      type: "import-openreview",
      input: url,
    });

    if (result.success) {
      btn.textContent = "✓ Imported";
      btn.style.background = "#16a34a";
      showResult(
        result.alreadyExists ? "warning" : "success",
        result.alreadyExists ? "Already in Arcana" : "Paper imported!",
        result.paper?.id
      );
    } else {
      btn.textContent = "Import to Arcana";
      btn.disabled = false;
      showResult("error", result.error || "Import failed");
    }

    loadHistory();
  });
}

function showPdfUpload(url) {
  const filename = new URL(url).pathname.split("/").pop() || "paper.pdf";

  importSection.innerHTML = `
    <div class="detect-label">PDF Detected</div>
    <div class="detect-title">${escapeHtml(filename)}</div>
    <div style="display:flex;gap:8px">
      <button id="upload-btn" class="btn btn-primary">Upload to Arcana</button>
      <button id="annotate-btn" class="btn" style="background:#d97706;color:#fff">Annotate PDF</button>
    </div>
  `;

  document.getElementById("upload-btn").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Uploading…";

    const result = await chrome.runtime.sendMessage({
      type: "upload-pdf",
      url: url,
    });

    if (result.success) {
      btn.textContent = "✓ Uploaded";
      btn.style.background = "#16a34a";
      showResult("success", "PDF uploaded!", result.paper?.id);
    } else {
      btn.textContent = "Upload to Arcana";
      btn.disabled = false;
      showResult("error", result.error || "Upload failed");
    }

    loadHistory();
  });

  document.getElementById("annotate-btn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "open-viewer", url });
    window.close();
  });
}

function showNoAction() {
  importSection.innerHTML = `
    <p class="no-action">Navigate to an arXiv, OpenReview, or PDF page to import</p>
  `;
}

function showResult(type, message, paperId) {
  resultDiv.className = `result ${type}`;
  let html = `<span>${escapeHtml(message)}</span>`;
  if (paperId) {
    html += ` <a href="${baseUrl}/papers/${paperId}" target="_blank">View →</a>`;
  }
  resultDiv.innerHTML = html;
}

async function checkHealth() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "check-health" });
    if (result.reachable) {
      statusDot.className = "dot green";
      statusText.textContent = "Connected";
    } else {
      statusDot.className = "dot red";
      statusText.textContent = "Unreachable";
    }
  } catch {
    statusDot.className = "dot red";
    statusText.textContent = "Unreachable";
  }
}

async function loadHistory() {
  const historyDiv = document.getElementById("history");
  const { importHistory = [] } = await chrome.storage.local.get("importHistory");

  if (importHistory.length === 0) {
    historyDiv.innerHTML = `<p class="muted">No imports yet</p>`;
    return;
  }

  historyDiv.innerHTML = importHistory
    .map((item) => {
      const icon = item.success ? "✓" : "✗";
      const iconColor = item.success ? "#16a34a" : "#dc2626";
      const time = formatTime(item.timestamp);
      const title = item.title || "Unknown";
      const link = item.paperId
        ? `<a href="${baseUrl}/papers/${item.paperId}" target="_blank">${escapeHtml(title)}</a>`
        : escapeHtml(title);

      return `
        <div class="history-item">
          <span class="history-icon" style="color:${iconColor}">${icon}</span>
          <span class="history-title">${link}${item.note ? ` <span class="muted">(${escapeHtml(item.note)})</span>` : ""}</span>
          <span class="history-time">${time}</span>
        </div>
      `;
    })
    .join("");
}

function formatTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Settings ---

saveUrlBtn.addEventListener("click", async () => {
  const url = baseUrlInput.value.trim().replace(/\/+$/, "");
  if (!url) return;
  baseUrl = url;
  await chrome.storage.sync.set({ baseUrl: url });
  saveUrlBtn.textContent = "Saved!";
  setTimeout(() => (saveUrlBtn.textContent = "Save"), 1500);
  checkHealth();
});

// --- PDF auto-open toggle ---
pdfAutoOpenCheckbox.addEventListener("change", () => {
  chrome.storage.sync.set({ pdfAutoOpen: pdfAutoOpenCheckbox.checked });
});

// --- Start ---
init();

const DEFAULT_BASE_URL = "http://localhost:3000";

// ---- PDF auto-redirect (Arcana PDFs only) ----
// When a page from Arcana finishes loading and is a PDF, redirect to our viewer.
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (details.url.startsWith("chrome-extension://")) return;

  const { pdfAutoOpen } = await chrome.storage.sync.get({ pdfAutoOpen: true });
  if (!pdfAutoOpen) return;

  // Only redirect PDFs served by Arcana
  const baseUrl = await getBaseUrl();
  if (!details.url.startsWith(baseUrl)) return;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      func: () => document.contentType,
    });

    if (result?.result !== "application/pdf") return;

    // Extract paperId from Arcana URL pattern: /api/papers/[id]/file
    const urlPath = new URL(details.url).pathname;
    const match = urlPath.match(/\/api\/papers\/([^/]+)\/file/);
    const paperId = match?.[1] || "";

    const params = new URLSearchParams({ url: details.url });
    if (paperId) {
      params.set("paperId", paperId);
    }

    const viewerUrl = chrome.runtime.getURL(`viewer.html?${params.toString()}`);
    await chrome.tabs.update(details.tabId, { url: viewerUrl });
  } catch {
    // scripting.executeScript may fail on restricted pages
  }
});

async function getBaseUrl() {
  const { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULT_BASE_URL });
  return baseUrl.replace(/\/+$/, "");
}

async function addToHistory(entry) {
  const { importHistory = [] } = await chrome.storage.local.get("importHistory");
  importHistory.unshift({
    ...entry,
    timestamp: Date.now(),
  });
  // Keep only the last 5
  await chrome.storage.local.set({
    importHistory: importHistory.slice(0, 5),
  });
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  // Clear badge after 3 seconds
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
}

async function importArxiv(input) {
  const baseUrl = await getBaseUrl();
  const response = await fetch(`${baseUrl}/api/papers/import/arxiv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });

  const data = await response.json();

  if (response.status === 201) {
    setBadge("✓", "#16a34a");
    await addToHistory({
      type: "arxiv",
      title: data.title || input,
      paperId: data.id,
      success: true,
    });
    return { success: true, paper: data };
  }

  if (response.status === 409) {
    setBadge("!", "#eab308");
    await addToHistory({
      type: "arxiv",
      title: data.paper?.title || input,
      paperId: data.paper?.id,
      success: true,
      note: "Already imported",
    });
    return { success: true, paper: data.paper, alreadyExists: true };
  }

  setBadge("✗", "#dc2626");
  await addToHistory({
    type: "arxiv",
    title: input,
    success: false,
    error: data.error,
  });
  return { success: false, error: data.error || "Import failed" };
}

async function importOpenReview(input) {
  const baseUrl = await getBaseUrl();
  const response = await fetch(`${baseUrl}/api/papers/import/openreview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });

  const data = await response.json();

  if (response.status === 201) {
    setBadge("✓", "#16a34a");
    await addToHistory({
      type: "openreview",
      title: data.title || input,
      paperId: data.id,
      success: true,
    });
    return { success: true, paper: data };
  }

  if (response.status === 409) {
    setBadge("!", "#eab308");
    await addToHistory({
      type: "openreview",
      title: data.paper?.title || input,
      paperId: data.paper?.id,
      success: true,
      note: "Already imported",
    });
    return { success: true, paper: data.paper, alreadyExists: true };
  }

  setBadge("✗", "#dc2626");
  await addToHistory({
    type: "openreview",
    title: input,
    success: false,
    error: data.error,
  });
  return { success: false, error: data.error || "Import failed" };
}

async function uploadPdf(pdfUrl, includeSourceUrl = false) {
  const baseUrl = await getBaseUrl();

  // Fetch the PDF
  const pdfResponse = await fetch(pdfUrl);
  if (!pdfResponse.ok) {
    const error = `Failed to fetch PDF: ${pdfResponse.status}`;
    setBadge("✗", "#dc2626");
    await addToHistory({ type: "pdf", title: pdfUrl, success: false, error });
    return { success: false, error };
  }

  const pdfBlob = await pdfResponse.blob();

  // Extract filename from URL
  const urlPath = new URL(pdfUrl).pathname;
  const filename = urlPath.split("/").pop() || "paper.pdf";

  // Upload as multipart form
  const formData = new FormData();
  formData.append("file", pdfBlob, filename);
  if (includeSourceUrl) {
    formData.append("sourceUrl", pdfUrl);
  }

  const response = await fetch(`${baseUrl}/api/upload`, {
    method: "POST",
    body: formData,
  });

  const data = await response.json();

  if (response.status === 201) {
    setBadge("✓", "#16a34a");
    await addToHistory({
      type: "pdf",
      title: data.title || filename,
      paperId: data.id,
      success: true,
    });
    return { success: true, paper: data };
  }

  if (response.status === 409) {
    setBadge("!", "#eab308");
    await addToHistory({
      type: "pdf",
      title: data.paper?.title || filename,
      paperId: data.paper?.id,
      success: true,
      note: "Already imported",
    });
    return { success: true, paper: data.paper, alreadyExists: true };
  }

  setBadge("✗", "#dc2626");
  await addToHistory({
    type: "pdf",
    title: filename,
    success: false,
    error: data.error,
  });
  return { success: false, error: data.error || "Upload failed" };
}

async function lookupPaper(sourceUrl) {
  const baseUrl = await getBaseUrl();
  try {
    const response = await fetch(
      `${baseUrl}/api/papers/lookup?sourceUrl=${encodeURIComponent(sourceUrl)}`
    );
    if (response.ok) {
      const paper = await response.json();
      return { success: true, paper };
    }
    return { success: false };
  } catch {
    return { success: false };
  }
}

async function fetchAnnotations(paperId) {
  const baseUrl = await getBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/api/papers/${paperId}/annotations`);
    if (response.ok) {
      const annotations = await response.json();
      return { success: true, annotations };
    }
    return { success: false };
  } catch {
    return { success: false };
  }
}

async function saveAnnotation(paperId, annotation) {
  const baseUrl = await getBaseUrl();
  const response = await fetch(`${baseUrl}/api/papers/${paperId}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(annotation),
  });

  if (response.status === 201) {
    const entry = await response.json();
    return { success: true, entry };
  }

  const data = await response.json().catch(() => ({}));
  return { success: false, error: data.error || "Save failed" };
}

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] || "image/png";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function saveScreenshot(paperId, screenshot) {
  const baseUrl = await getBaseUrl();

  const blob = dataUrlToBlob(screenshot.dataUrl);

  const formData = new FormData();
  formData.append("image", blob, "screenshot.png");
  formData.append("pageNumber", String(screenshot.pageNumber));
  formData.append("rect", JSON.stringify(screenshot.rect));
  if (screenshot.note) {
    formData.append("note", screenshot.note);
  }

  const res = await fetch(`${baseUrl}/api/papers/${paperId}/annotations/screenshots`, {
    method: "POST",
    body: formData,
  });

  if (res.status === 201) {
    const entry = await res.json();
    return { success: true, entry };
  }

  const data = await res.json().catch(() => ({}));
  return { success: false, error: data.error || "Save failed" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "import-arxiv") {
    importArxiv(message.input).then(sendResponse);
    return true; // keep channel open for async response
  }

  if (message.type === "import-openreview") {
    importOpenReview(message.input).then(sendResponse);
    return true;
  }

  if (message.type === "upload-pdf") {
    uploadPdf(message.url).then(sendResponse);
    return true;
  }

  if (message.type === "open-viewer") {
    (async () => {
      // Look up paper to get paperId and title
      const lookup = await lookupPaper(message.url);
      const params = new URLSearchParams({ url: message.url });
      if (lookup.success) {
        params.set("paperId", lookup.paper.id);
        params.set("paperTitle", lookup.paper.title);
      } else {
        // Use filename as title
        try {
          const filename = new URL(message.url).pathname.split("/").pop() || "PDF";
          params.set("paperTitle", filename.replace(/\.pdf$/i, ""));
        } catch {
          params.set("paperTitle", "PDF");
        }
      }
      const viewerUrl = chrome.runtime.getURL(`viewer.html?${params.toString()}`);
      chrome.tabs.create({ url: viewerUrl });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === "lookup-paper") {
    lookupPaper(message.url).then(sendResponse);
    return true;
  }

  if (message.type === "upload-pdf-with-source") {
    uploadPdf(message.url, true).then(sendResponse);
    return true;
  }

  if (message.type === "fetch-annotations") {
    fetchAnnotations(message.paperId).then(sendResponse);
    return true;
  }

  if (message.type === "save-annotation") {
    saveAnnotation(message.paperId, message.annotation).then(sendResponse);
    return true;
  }

  if (message.type === "save-screenshot") {
    saveScreenshot(message.paperId, message.screenshot)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "check-health") {
    getBaseUrl()
      .then((baseUrl) => fetch(`${baseUrl}/api/papers`, { method: "GET" }))
      .then((res) => sendResponse({ reachable: res.ok }))
      .catch(() => sendResponse({ reachable: false }));
    return true;
  }
});

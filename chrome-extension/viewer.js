import * as pdfjsLib from "./lib/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "lib/pdfjs/pdf.worker.min.mjs"
);

// ---- State ----
let pdfDoc = null;
let currentScale = 1.5;
let annotations = []; // { id, type, pageNumber, rects, selectedText, note, color, synced, serverId, dataUrl, rect }
let selectedColor = "yellow";
let pendingSelection = null; // { text, pageNumber, rects }
let activePopoverAnnotationId = null;
let selectionMode = "text"; // "text" | "area"
let areaSelectState = null; // { overlay, rect, startX, startY, pageNumber, wrapper }
let pendingScreenshot = null; // { dataUrl, pageNumber, rect }
let llmPanelState = { open: false, conversationId: null, mode: null, context: "", imageDataUrl: null, responseText: "", loading: false, pageNumber: null };

// URL params
const params = new URLSearchParams(window.location.search);
const hashUrl = window.location.hash.length > 1 ? window.location.hash.slice(1) : null;
const pdfUrl = params.get("url") || hashUrl;
const paperId = params.get("paperId") || null;
const paperTitle = params.get("paperTitle") || "";

// Derive display title
let displayTitle = paperTitle ? decodeURIComponent(paperTitle) : "";
if (!displayTitle && pdfUrl) {
  try {
    const filename = new URL(pdfUrl).pathname.split("/").pop() || "PDF";
    displayTitle = decodeURIComponent(filename.replace(/\.pdf$/i, ""));
  } catch {
    displayTitle = "PDF";
  }
}

// DOM
const viewerContainer = document.getElementById("viewer-container");
const titleEl = document.getElementById("paper-title");
const pageInput = document.getElementById("page-input");
const pageCountEl = document.getElementById("page-count");
const zoomLevelEl = document.getElementById("zoom-level");
const sidebar = document.getElementById("sidebar");
const annotationList = document.getElementById("annotation-list");
const annotationCountEl = document.getElementById("annotation-count");
const selectionToolbar = document.getElementById("selection-toolbar");
const notePopover = document.getElementById("note-popover");
const noteInput = document.getElementById("note-input");
const annotationPopover = document.getElementById("annotation-popover");
const screenshotPopover = document.getElementById("screenshot-popover");
const screenshotPreview = document.getElementById("screenshot-preview");
const screenshotNoteInput = document.getElementById("screenshot-note");
const toast = document.getElementById("toast");
const llmPanel = document.getElementById("llm-panel");
const llmPanelTitle = document.getElementById("llm-panel-title");
const llmContextEl = document.getElementById("llm-context");
const llmResponseEl = document.getElementById("llm-response");
const llmInputArea = document.getElementById("llm-input-area");
const llmInput = document.getElementById("llm-input");
const llmActionsEl = document.getElementById("llm-actions");

const llmOpenArcana = document.getElementById("llm-open-arcana");

const API_BASE = "http://localhost:3000";

// ---- Init ----
titleEl.textContent = displayTitle;
document.title = `Arcana — ${displayTitle}`;

const openOriginalLink = document.getElementById("open-original");
if (pdfUrl) {
  openOriginalLink.href = pdfUrl;
}

async function init() {
  if (!pdfUrl) {
    titleEl.textContent = "Error: No PDF URL provided";
    return;
  }

  try {
    pdfDoc = await pdfjsLib.getDocument({ url: pdfUrl }).promise;
    pageCountEl.textContent = pdfDoc.numPages;
    pageInput.max = pdfDoc.numPages;

    await renderAllPages();
    await restoreAnnotations();
  } catch (err) {
    console.error("Failed to load PDF:", err);
    titleEl.textContent = "Failed to load PDF";
    viewerContainer.innerHTML = `<div style="color:#f87171;padding:40px;text-align:center">
      <p>Could not load PDF from:</p>
      <p style="word-break:break-all;margin-top:8px;color:#888">${pdfUrl}</p>
      <p style="margin-top:8px">${err.message}</p>
    </div>`;
  }
}

// ---- Render pages ----
async function renderAllPages() {
  viewerContainer.innerHTML = "";

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: currentScale });

    // Page wrapper
    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page-wrapper";
    wrapper.dataset.page = i;
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;

    // Canvas
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    wrapper.appendChild(canvas);

    // Text layer
    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    wrapper.appendChild(textLayerDiv);
    await renderTextLayer(page, viewport, textLayerDiv);

    // Highlight layer
    const highlightLayer = document.createElement("div");
    highlightLayer.className = "highlight-layer";
    wrapper.appendChild(highlightLayer);

    viewerContainer.appendChild(wrapper);
  }

  renderHighlights();

  if (selectionMode === "area") {
    addAreaOverlays();
  }
}

// ---- Manual text layer with scaleX measurement for correct widths ----
function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

async function renderTextLayer(page, viewport, container) {
  const textContent = await page.getTextContent();
  const items = textContent.items;
  const spanInfo = [];

  for (const item of items) {
    if (!item.str) continue;

    // Combine viewport transform with the item's text transform
    const tx = matMul(viewport.transform, item.transform);

    // Font height in pixels (magnitude of the y-axis component)
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (fontHeight < 1) continue;

    // Position: tx[4]=x, tx[5]=baseline y (screen coords, y-down)
    const left = tx[4];
    const top = tx[5] - fontHeight;

    // Expected width in screen pixels
    const expectedWidth = item.width * viewport.scale;

    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.fontSize = `${fontHeight}px`;
    span.style.fontFamily =
      textContent.styles[item.fontName]?.fontFamily || "sans-serif";
    span.style.left = `${left}px`;
    span.style.top = `${top}px`;

    container.appendChild(span);
    spanInfo.push({ span, expectedWidth });
  }

  // Measure actual rendered widths and apply scaleX to match expected widths
  for (const { span, expectedWidth } of spanInfo) {
    if (expectedWidth <= 0) continue;
    const actualWidth = span.getBoundingClientRect().width;
    if (actualWidth > 0) {
      const scaleX = expectedWidth / actualWidth;
      if (Math.abs(scaleX - 1) > 0.001) {
        span.style.transform = `scaleX(${scaleX})`;
      }
    }
  }
}

// ---- Mode toggle ----
document.getElementById("mode-text").addEventListener("click", () => setSelectionMode("text"));
document.getElementById("mode-area").addEventListener("click", () => setSelectionMode("area"));

function setSelectionMode(mode) {
  selectionMode = mode;
  document.getElementById("mode-text").classList.toggle("active", mode === "text");
  document.getElementById("mode-area").classList.toggle("active", mode === "area");
  document.body.classList.toggle("area-mode", mode === "area");

  if (mode === "area") {
    addAreaOverlays();
  } else {
    removeAreaOverlays();
  }
}

function addAreaOverlays() {
  removeAreaOverlays();
  viewerContainer.querySelectorAll(".pdf-page-wrapper").forEach((wrapper) => {
    const overlay = document.createElement("div");
    overlay.className = "area-select-overlay";
    wrapper.appendChild(overlay);
    setupAreaHandlers(overlay, wrapper);
  });
}

function removeAreaOverlays() {
  viewerContainer.querySelectorAll(".area-select-overlay").forEach((o) => o.remove());
}

function setupAreaHandlers(overlay, wrapper) {
  let rectEl = null;
  let startX, startY;

  overlay.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const wrapperRect = wrapper.getBoundingClientRect();
    startX = e.clientX - wrapperRect.left;
    startY = e.clientY - wrapperRect.top;

    rectEl = document.createElement("div");
    rectEl.className = "area-select-rect";
    rectEl.style.left = `${startX}px`;
    rectEl.style.top = `${startY}px`;
    rectEl.style.width = "0px";
    rectEl.style.height = "0px";
    wrapper.appendChild(rectEl);

    areaSelectState = { overlay, rectEl, startX, startY, wrapper };
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!areaSelectState || areaSelectState.overlay !== overlay) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const curX = e.clientX - wrapperRect.left;
    const curY = e.clientY - wrapperRect.top;

    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);

    areaSelectState.rectEl.style.left = `${x}px`;
    areaSelectState.rectEl.style.top = `${y}px`;
    areaSelectState.rectEl.style.width = `${w}px`;
    areaSelectState.rectEl.style.height = `${h}px`;
  });

  overlay.addEventListener("mouseup", (e) => {
    if (!areaSelectState || areaSelectState.overlay !== overlay) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const endX = e.clientX - wrapperRect.left;
    const endY = e.clientY - wrapperRect.top;

    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const w = Math.abs(endX - startX);
    const h = Math.abs(endY - startY);

    // Remove the dashed rect
    if (areaSelectState.rectEl) areaSelectState.rectEl.remove();
    areaSelectState = null;

    // Minimum size check
    if (w < 10 || h < 10) return;

    const pageNumber = parseInt(wrapper.dataset.page);
    captureScreenshot(wrapper, x, y, w, h, pageNumber, e);
  });
}

function captureScreenshot(wrapper, x, y, w, h, pageNumber, event) {
  const sourceCanvas = wrapper.querySelector("canvas");
  if (!sourceCanvas) return;

  // Canvas pixel coordinates match the CSS pixel positions since canvas dimensions = wrapper dimensions
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = w;
  tempCanvas.height = h;
  const ctx = tempCanvas.getContext("2d");
  ctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);
  const dataUrl = tempCanvas.toDataURL("image/png");

  // Store rect in unscaled coords for persistence
  const rect = {
    x: x / currentScale,
    y: y / currentScale,
    w: w / currentScale,
    h: h / currentScale,
  };

  pendingScreenshot = { dataUrl, pageNumber, rect };

  // Show screenshot popover
  screenshotPreview.src = dataUrl;
  screenshotNoteInput.value = "";
  screenshotPopover.classList.remove("hidden");

  // Position near the selection
  const popX = event.clientX + 10;
  const popY = event.clientY + 10;
  screenshotPopover.style.left = `${popX}px`;
  screenshotPopover.style.top = `${popY}px`;

  requestAnimationFrame(() => {
    const rect = screenshotPopover.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      screenshotPopover.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
      screenshotPopover.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
  });
}

function hideScreenshotPopover() {
  screenshotPopover.classList.add("hidden");
  pendingScreenshot = null;
}

document.getElementById("screenshot-save").addEventListener("click", () => {
  if (!pendingScreenshot) return;
  const { dataUrl, pageNumber, rect } = pendingScreenshot;
  const note = screenshotNoteInput.value.trim();
  addScreenshotAnnotation(dataUrl, pageNumber, rect, note);
  hideScreenshotPopover();
});

document.getElementById("screenshot-cancel").addEventListener("click", () => {
  hideScreenshotPopover();
});

function addScreenshotAnnotation(dataUrl, pageNumber, rect, note) {
  const annotation = {
    id: crypto.randomUUID(),
    type: "screenshot",
    pageNumber,
    rect,
    rects: [],
    selectedText: "",
    note: note || "",
    color: "screenshot",
    dataUrl,
    synced: false,
  };

  annotations.push(annotation);
  saveLocal();
  renderHighlights();
  updateSidebar();

  if (paperId) {
    syncScreenshot(annotation);
  }
}

async function syncScreenshot(ann) {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "save-screenshot",
      paperId,
      screenshot: {
        dataUrl: ann.dataUrl,
        pageNumber: ann.pageNumber,
        rect: ann.rect,
        note: ann.note,
      },
    });

    if (result.success) {
      ann.synced = true;
      ann.serverId = result.entry.id;
      // Store server screenshot path for restore
      if (result.entry.content?.screenshotPath) {
        ann.screenshotPath = result.entry.content.screenshotPath;
      }
      saveLocal();
      showToast("Screenshot saved", "success");
    } else {
      showToast("Screenshot save failed", "error");
    }
  } catch {
    showToast("Screenshot save failed", "error");
  }
}

// ---- Scroll tracking ----
viewerContainer.addEventListener("scroll", () => {
  const wrappers = viewerContainer.querySelectorAll(".pdf-page-wrapper");
  const containerRect = viewerContainer.getBoundingClientRect();
  const containerCenter = containerRect.top + containerRect.height / 2;

  let closestPage = 1;
  let closestDist = Infinity;

  for (const w of wrappers) {
    const rect = w.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const dist = Math.abs(center - containerCenter);
    if (dist < closestDist) {
      closestDist = dist;
      closestPage = parseInt(w.dataset.page);
    }
  }

  pageInput.value = closestPage;
});

// ---- Text selection ----
viewerContainer.addEventListener("mouseup", () => {
  if (selectionMode !== "text") return;

  const sel = window.getSelection();
  const text = sel?.toString().trim();

  if (!text) {
    hideSelectionToolbar();
    return;
  }

  const range = sel.getRangeAt(0);
  const wrapper = range.startContainer.parentElement?.closest(".pdf-page-wrapper");
  if (!wrapper) {
    hideSelectionToolbar();
    return;
  }

  const pageNumber = parseInt(wrapper.dataset.page);
  const rects = getSelectionRects(range, wrapper);

  if (rects.length === 0) {
    hideSelectionToolbar();
    return;
  }

  pendingSelection = { text, pageNumber, rects };

  const lastRect = range.getBoundingClientRect();
  selectionToolbar.classList.remove("hidden");
  selectionToolbar.style.left = `${lastRect.right + window.scrollX - 50}px`;
  selectionToolbar.style.top = `${lastRect.bottom + window.scrollY + 8}px`;
});

function getSelectionRects(range, wrapper) {
  const clientRects = range.getClientRects();
  const wrapperRect = wrapper.getBoundingClientRect();
  const rects = [];

  for (const cr of clientRects) {
    rects.push({
      x: (cr.left - wrapperRect.left) / currentScale,
      y: (cr.top - wrapperRect.top) / currentScale,
      w: cr.width / currentScale,
      h: cr.height / currentScale,
    });
  }

  return rects;
}

function hideSelectionToolbar() {
  selectionToolbar.classList.add("hidden");
  pendingSelection = null;
}

function hideNotePopover() {
  notePopover.classList.add("hidden");
  noteInput.value = "";
}

function hideAnnotationPopover() {
  annotationPopover.classList.add("hidden");
  activePopoverAnnotationId = null;
}

// ---- Highlight actions ----
document.getElementById("btn-highlight").addEventListener("click", () => {
  if (!pendingSelection) return;
  addAnnotation(pendingSelection.text, pendingSelection.pageNumber, pendingSelection.rects, "");
  window.getSelection()?.removeAllRanges();
  hideSelectionToolbar();
});

document.getElementById("btn-highlight-note").addEventListener("click", () => {
  if (!pendingSelection) return;

  const stRect = selectionToolbar.getBoundingClientRect();
  notePopover.classList.remove("hidden");
  notePopover.style.left = `${stRect.left}px`;
  notePopover.style.top = `${stRect.bottom + 8}px`;
  noteInput.focus();

  selectionToolbar.classList.add("hidden");
});

document.getElementById("note-save").addEventListener("click", () => {
  if (!pendingSelection) return;
  addAnnotation(pendingSelection.text, pendingSelection.pageNumber, pendingSelection.rects, noteInput.value.trim());
  window.getSelection()?.removeAllRanges();
  hideNotePopover();
  pendingSelection = null;
});

document.getElementById("note-cancel").addEventListener("click", () => {
  hideNotePopover();
  pendingSelection = null;
});

// ---- Color dots in selection toolbar ----
document.querySelectorAll("#selection-toolbar .color-dot").forEach((dot) => {
  dot.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll("#selection-toolbar .color-dot").forEach((d) => d.classList.remove("active"));
    dot.classList.add("active");
    selectedColor = dot.dataset.color;
  });
});

// ---- Add annotation (auto-saves to Arcana if paperId is available) ----
function addAnnotation(text, pageNumber, rects, note) {
  const annotation = {
    id: crypto.randomUUID(),
    pageNumber,
    rects,
    selectedText: text,
    note: note || "",
    color: selectedColor,
    synced: false,
  };

  annotations.push(annotation);
  saveLocal();
  renderHighlights();
  updateSidebar();

  // Auto-save to Arcana
  if (paperId) {
    syncAnnotation(annotation);
  }
}

async function syncAnnotation(ann) {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "save-annotation",
      paperId,
      annotation: {
        selectedText: ann.selectedText,
        note: ann.note,
        pageNumber: ann.pageNumber,
        rects: ann.rects,
        color: ann.color,
      },
    });

    if (result.success) {
      ann.synced = true;
      ann.serverId = result.entry.id;
      saveLocal();
      showToast("Saved", "success");
    } else {
      showToast("Save failed — will retry later", "error");
    }
  } catch {
    showToast("Save failed — will retry later", "error");
  }
}

// ---- Render highlights ----
function renderHighlights() {
  document.querySelectorAll(".highlight-layer").forEach((l) => (l.innerHTML = ""));

  for (const ann of annotations) {
    const wrapper = viewerContainer.querySelector(`.pdf-page-wrapper[data-page="${ann.pageNumber}"]`);
    if (!wrapper) continue;
    const layer = wrapper.querySelector(".highlight-layer");

    // Screenshot annotations
    if (ann.type === "screenshot" && ann.rect) {
      const el = document.createElement("div");
      el.className = "screenshot-region";
      el.dataset.annotationId = ann.id;
      el.style.left = `${ann.rect.x * currentScale}px`;
      el.style.top = `${ann.rect.y * currentScale}px`;
      el.style.width = `${ann.rect.w * currentScale}px`;
      el.style.height = `${ann.rect.h * currentScale}px`;

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        showAnnotationPopover(ann, e);
      });

      layer.appendChild(el);
      continue;
    }

    // Text highlight annotations
    for (const r of ann.rects) {
      const el = document.createElement("div");
      el.className = "annotation-highlight";
      if (ann.note) el.classList.add("has-note");
      el.dataset.color = ann.color;
      el.dataset.annotationId = ann.id;
      el.style.left = `${r.x * currentScale}px`;
      el.style.top = `${r.y * currentScale}px`;
      el.style.width = `${r.w * currentScale}px`;
      el.style.height = `${r.h * currentScale}px`;

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        showAnnotationPopover(ann, e);
      });

      layer.appendChild(el);
    }
  }
}

// ---- Annotation popover ----
function showAnnotationPopover(ann, event) {
  activePopoverAnnotationId = ann.id;

  if (ann.type === "screenshot") {
    document.getElementById("popover-text").innerHTML = `<img src="${escapeHtml(ann.dataUrl || "")}" style="max-width:100%;max-height:100px;border-radius:4px;margin-bottom:4px">`;
    document.getElementById("popover-text").insertAdjacentHTML("beforeend", `<div style="font-size:11px;color:#888">Page ${ann.pageNumber} screenshot</div>`);
  } else {
    document.getElementById("popover-text").textContent = (ann.selectedText || "").slice(0, 200);
  }
  document.getElementById("popover-note").textContent = ann.note || "";

  annotationPopover.querySelectorAll(".color-dot").forEach((d) => {
    d.classList.toggle("active", d.dataset.color === ann.color);
  });

  annotationPopover.classList.remove("hidden");
  annotationPopover.style.left = `${event.clientX + 10}px`;
  annotationPopover.style.top = `${event.clientY + 10}px`;

  requestAnimationFrame(() => {
    const rect = annotationPopover.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      annotationPopover.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
      annotationPopover.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
  });
}

annotationPopover.querySelectorAll(".color-dot").forEach((dot) => {
  dot.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!activePopoverAnnotationId) return;
    const ann = annotations.find((a) => a.id === activePopoverAnnotationId);
    if (!ann) return;
    ann.color = dot.dataset.color;
    ann.synced = false;
    annotationPopover.querySelectorAll(".color-dot").forEach((d) => d.classList.toggle("active", d.dataset.color === ann.color));
    saveLocal();
    renderHighlights();
    updateSidebar();
  });
});

document.getElementById("popover-edit").addEventListener("click", () => {
  if (!activePopoverAnnotationId) return;
  const ann = annotations.find((a) => a.id === activePopoverAnnotationId);
  if (!ann) return;

  hideAnnotationPopover();

  const rect = annotationPopover.getBoundingClientRect();
  notePopover.classList.remove("hidden");
  notePopover.style.left = `${rect.left}px`;
  notePopover.style.top = `${rect.top}px`;
  noteInput.value = ann.note;
  noteInput.focus();

  const saveBtn = document.getElementById("note-save");
  const origHandler = saveBtn.onclick;
  saveBtn.onclick = () => {
    ann.note = noteInput.value.trim();
    ann.synced = false;
    saveLocal();
    renderHighlights();
    updateSidebar();
    hideNotePopover();
    saveBtn.onclick = origHandler;
    showToast("Note updated", "success");
  };

  const cancelBtn = document.getElementById("note-cancel");
  const origCancel = cancelBtn.onclick;
  cancelBtn.onclick = () => {
    hideNotePopover();
    saveBtn.onclick = origHandler;
    cancelBtn.onclick = origCancel;
  };
});

document.getElementById("popover-delete").addEventListener("click", () => {
  if (!activePopoverAnnotationId) return;
  annotations = annotations.filter((a) => a.id !== activePopoverAnnotationId);
  hideAnnotationPopover();
  saveLocal();
  renderHighlights();
  updateSidebar();
  showToast("Highlight removed", "success");
});

// Close popovers on outside click
document.addEventListener("click", (e) => {
  if (!annotationPopover.contains(e.target) && !e.target.closest(".annotation-highlight")) {
    hideAnnotationPopover();
  }
});

// ---- Sidebar ----
function updateSidebar() {
  annotationCountEl.textContent = annotations.length;

  if (annotations.length === 0) {
    annotationList.innerHTML = '<div class="sidebar-empty">No annotations yet. Select text to start highlighting.</div>';
    return;
  }

  const grouped = {};
  for (const ann of annotations) {
    if (!grouped[ann.pageNumber]) grouped[ann.pageNumber] = [];
    grouped[ann.pageNumber].push(ann);
  }

  let html = "";
  for (const page of Object.keys(grouped).sort((a, b) => a - b)) {
    for (const ann of grouped[page]) {
      if (ann.type === "screenshot") {
        const imgSrc = ann.dataUrl || "";
        html += `
          <div class="sidebar-annotation" data-color="screenshot" data-id="${ann.id}">
            <div class="sa-page">Page ${page} — Screenshot</div>
            ${imgSrc ? `<div class="sa-screenshot"><img src="${escapeHtml(imgSrc)}" alt="Screenshot"></div>` : ""}
            ${ann.note ? `<div class="sa-note">${escapeHtml(ann.note)}</div>` : ""}
          </div>
        `;
      } else {
        html += `
          <div class="sidebar-annotation" data-color="${ann.color}" data-id="${ann.id}">
            <div class="sa-page">Page ${page}</div>
            <div class="sa-text">${escapeHtml(ann.selectedText)}</div>
            ${ann.note ? `<div class="sa-note">${escapeHtml(ann.note)}</div>` : ""}
          </div>
        `;
      }
    }
  }

  annotationList.innerHTML = html;

  annotationList.querySelectorAll(".sidebar-annotation").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      const highlight = viewerContainer.querySelector(`[data-annotation-id="${id}"]`);
      if (highlight) {
        highlight.scrollIntoView({ behavior: "smooth", block: "center" });
        highlight.style.outline = "2px solid #fff";
        setTimeout(() => (highlight.style.outline = ""), 1000);
      }
    });
  });
}

// ---- Page navigation ----
document.getElementById("prev-page").addEventListener("click", () => {
  const current = parseInt(pageInput.value);
  if (current > 1) goToPage(current - 1);
});

document.getElementById("next-page").addEventListener("click", () => {
  const current = parseInt(pageInput.value);
  if (current < pdfDoc.numPages) goToPage(current + 1);
});

pageInput.addEventListener("change", () => {
  const page = parseInt(pageInput.value);
  if (page >= 1 && page <= pdfDoc.numPages) goToPage(page);
});

function goToPage(num) {
  pageInput.value = num;
  const wrapper = viewerContainer.querySelector(`.pdf-page-wrapper[data-page="${num}"]`);
  if (wrapper) wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- Zoom ----
document.getElementById("zoom-out").addEventListener("click", () => setZoom(currentScale - 0.25));
document.getElementById("zoom-in").addEventListener("click", () => setZoom(currentScale + 0.25));

async function setZoom(scale) {
  scale = Math.max(0.5, Math.min(3, scale));
  if (scale === currentScale) return;
  currentScale = scale;
  zoomLevelEl.textContent = `${Math.round(scale * 100)}%`;

  const scrollRatio = viewerContainer.scrollTop / (viewerContainer.scrollHeight || 1);
  await renderAllPages();
  viewerContainer.scrollTop = scrollRatio * viewerContainer.scrollHeight;
}

zoomLevelEl.textContent = `${Math.round(currentScale * 100)}%`;

// ---- Sidebar toggle ----
document.getElementById("toggle-sidebar").addEventListener("click", () => {
  sidebar.classList.toggle("hidden");
});

// ---- Local storage ----
function storageKey() {
  return `arcana-annotations-${pdfUrl}`;
}

function saveLocal() {
  chrome.storage.local.set({ [storageKey()]: annotations });
}

async function restoreAnnotations() {
  const result = await chrome.storage.local.get(storageKey());
  const local = result[storageKey()];

  if (local && local.length > 0) {
    annotations = local;
  }

  if (paperId) {
    try {
      const remote = await chrome.runtime.sendMessage({
        type: "fetch-annotations",
        paperId,
      });

      if (remote.success && remote.annotations) {
        const localServerIds = new Set(annotations.filter((a) => a.serverId).map((a) => a.serverId));

        for (const r of remote.annotations) {
          if (!localServerIds.has(r.id)) {
            if (r.content?.screenshotPath) {
              // Screenshot annotation from server
              const baseUrl = new URL(pdfUrl).origin;
              const imageUrl = `${baseUrl}/api/screenshots/${r.content.screenshotPath.split("/").pop()}`;
              annotations.push({
                id: crypto.randomUUID(),
                serverId: r.id,
                type: "screenshot",
                pageNumber: r.content.pageNumber || 1,
                rect: r.content.rect || { x: 0, y: 0, w: 0, h: 0 },
                rects: [],
                selectedText: "",
                note: r.annotation || "",
                color: "screenshot",
                dataUrl: imageUrl,
                screenshotPath: r.content.screenshotPath,
                synced: true,
              });
            } else {
              annotations.push({
                id: crypto.randomUUID(),
                serverId: r.id,
                type: "selection",
                pageNumber: r.content?.pageNumber || 1,
                rects: r.content?.rects || [],
                selectedText: r.selectedText || "",
                note: r.annotation || "",
                color: r.content?.color || "yellow",
                synced: true,
              });
            }
          }
        }

        saveLocal();
      }
    } catch (e) {
      console.warn("Could not fetch remote annotations:", e);
    }
  }

  renderHighlights();
  updateSidebar();
}

// ---- Toast ----
function showToast(message, type) {
  toast.textContent = message;
  toast.className = type;

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.add("hidden");
  }, 3000);
}

// ---- Util ----
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---- LLM Panel ----
async function openLLMPanel(mode, context, pageNumber, imageDataUrl) {
  if (!paperId) {
    showToast("No paper linked — cannot use LLM", "error");
    return;
  }

  llmPanelState = { open: true, conversationId: null, mode, context, imageDataUrl: imageDataUrl || null, responseText: "", loading: true, pageNumber };

  // Show panel
  llmPanel.classList.remove("hidden");
  llmPanelTitle.textContent = mode === "explain" ? "Explanation" : "Quick Chat";
  llmContextEl.textContent = context.length > 200 ? context.slice(0, 197) + "…" : context;
  llmResponseEl.innerHTML = '<div class="llm-loading"><div class="llm-loading-spinner"></div>Creating conversation…</div>';
  llmActionsEl.classList.add("hidden");

  if (mode === "chat") {
    llmInputArea.classList.remove("hidden");
    llmInput.value = "";
    llmInput.focus();
  } else {
    llmInputArea.classList.add("hidden");
  }

  // Hide other popovers
  hideSelectionToolbar();
  hideAnnotationPopover();
  hideScreenshotPopover();

  // Create conversation
  try {
    const res = await fetch(`${API_BASE}/api/papers/${paperId}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedText: context, mode }),
    });
    if (!res.ok) throw new Error("Failed to create conversation");
    const conv = await res.json();
    llmPanelState.conversationId = conv.id;

    // For explain mode, auto-send
    if (mode === "explain") {
      const prompt = imageDataUrl
        ? `Explain this screenshot from page ${pageNumber} of the paper.${context.includes(":") ? " Context: " + context.split(":").slice(1).join(":").trim() : ""}`
        : `Explain this passage from the paper:\n\n"${context}"`;
      await sendLLMMessage(prompt);
    } else {
      llmPanelState.loading = false;
      llmResponseEl.innerHTML = "";
    }
  } catch (err) {
    llmPanelState.loading = false;
    llmResponseEl.innerHTML = `<div style="color:#f87171">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function sendLLMMessage(text) {
  if (!llmPanelState.conversationId) return;

  llmPanelState.loading = true;
  llmPanelState.responseText = "";
  llmActionsEl.classList.add("hidden");
  llmResponseEl.innerHTML = '<div class="llm-loading"><div class="llm-loading-spinner"></div>Thinking…</div>';

  const messagesUrl = `${API_BASE}/api/papers/${paperId}/conversations/${llmPanelState.conversationId}/messages`;

  try {
    // Build message content — multi-part if we have an image
    let messageContent;
    if (llmPanelState.imageDataUrl) {
      messageContent = [
        { type: "image", image: llmPanelState.imageDataUrl },
        { type: "text", text },
      ];
    } else {
      messageContent = text;
    }

    const res = await fetch(messagesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: messageContent }],
        brief: true,
      }),
    });

    if (!res.ok) throw new Error("Failed to get response");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    llmResponseEl.textContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      llmResponseEl.textContent = full;
      llmResponseEl.scrollTop = llmResponseEl.scrollHeight;
    }

    llmPanelState.responseText = full;
    llmPanelState.loading = false;

    // Show actions (save to notebook + continue in Arcana)
    llmActionsEl.classList.remove("hidden");
    llmOpenArcana.href = `${API_BASE}/papers/${paperId}?conv=${llmPanelState.conversationId}`;

    // For chat mode, show input for follow-up
    if (llmPanelState.mode === "chat") {
      llmInputArea.classList.remove("hidden");
      llmInput.value = "";
      llmInput.focus();
    }
  } catch (err) {
    llmPanelState.loading = false;
    llmResponseEl.innerHTML = `<div style="color:#f87171">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function closeLLMPanel() {
  llmPanel.classList.add("hidden");
  llmPanelState = { open: false, conversationId: null, mode: null, context: "", imageDataUrl: null, responseText: "", loading: false, pageNumber: null };
}

async function saveLLMToNotebook() {
  if (!llmPanelState.responseText || !paperId) return;

  try {
    const res = await fetch(`${API_BASE}/api/notebook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paperId,
        type: llmPanelState.mode === "explain" ? "explanation" : "chat",
        selectedText: llmPanelState.context,
        content: llmPanelState.responseText,
        conversationId: llmPanelState.conversationId,
      }),
    });

    if (!res.ok) throw new Error("Failed to save");
    showToast("Saved to notebook", "success");
  } catch {
    showToast("Failed to save to notebook", "error");
  }
}

// LLM panel button handlers
document.getElementById("llm-panel-close").addEventListener("click", closeLLMPanel);
document.getElementById("llm-save-notebook").addEventListener("click", saveLLMToNotebook);

document.getElementById("llm-send").addEventListener("click", () => {
  const text = llmInput.value.trim();
  if (!text || llmPanelState.loading) return;
  const fullText = `Regarding this passage from the paper:\n\n"${llmPanelState.context}"\n\n${text}`;
  llmInput.value = "";
  sendLLMMessage(fullText);
});

llmInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("llm-send").click();
  }
});

// Selection toolbar Explain/Chat buttons
document.getElementById("btn-explain").addEventListener("click", () => {
  if (!pendingSelection) return;
  openLLMPanel("explain", pendingSelection.text, pendingSelection.pageNumber);
  window.getSelection()?.removeAllRanges();
});

document.getElementById("btn-chat").addEventListener("click", () => {
  if (!pendingSelection) return;
  openLLMPanel("chat", pendingSelection.text, pendingSelection.pageNumber);
  window.getSelection()?.removeAllRanges();
});

// Screenshot popover Explain/Chat buttons — don't auto-save screenshot,
// just open LLM panel with the image. User can save screenshot separately.
document.getElementById("screenshot-explain").addEventListener("click", () => {
  if (!pendingScreenshot) return;
  const { dataUrl, pageNumber } = pendingScreenshot;
  const note = screenshotNoteInput.value.trim();
  hideScreenshotPopover();
  openLLMPanel("explain", `Screenshot from page ${pageNumber}${note ? ": " + note : ""}`, pageNumber, dataUrl);
});

document.getElementById("screenshot-chat").addEventListener("click", () => {
  if (!pendingScreenshot) return;
  const { dataUrl, pageNumber } = pendingScreenshot;
  const note = screenshotNoteInput.value.trim();
  hideScreenshotPopover();
  openLLMPanel("chat", `Screenshot from page ${pageNumber}${note ? ": " + note : ""}`, pageNumber, dataUrl);
});

// Annotation popover Explain/Chat buttons
document.getElementById("popover-explain").addEventListener("click", () => {
  if (!activePopoverAnnotationId) return;
  const ann = annotations.find((a) => a.id === activePopoverAnnotationId);
  if (!ann) return;
  const isScreenshot = ann.type === "screenshot";
  const context = isScreenshot
    ? `Screenshot from page ${ann.pageNumber}${ann.note ? ": " + ann.note : ""}`
    : ann.selectedText;
  hideAnnotationPopover();
  openLLMPanel("explain", context, ann.pageNumber, isScreenshot ? ann.dataUrl : undefined);
});

document.getElementById("popover-chat").addEventListener("click", () => {
  if (!activePopoverAnnotationId) return;
  const ann = annotations.find((a) => a.id === activePopoverAnnotationId);
  if (!ann) return;
  const isScreenshot = ann.type === "screenshot";
  const context = isScreenshot
    ? `Screenshot from page ${ann.pageNumber}${ann.note ? ": " + ann.note : ""}`
    : ann.selectedText;
  hideAnnotationPopover();
  openLLMPanel("chat", context, ann.pageNumber, isScreenshot ? ann.dataUrl : undefined);
});

// ---- Start ----
init();

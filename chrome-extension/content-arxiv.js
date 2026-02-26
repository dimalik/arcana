(() => {
  // Avoid double-injection
  if (document.getElementById("pf-import-btn")) return;

  // Extract arXiv ID from URL
  const match = window.location.pathname.match(/\/(abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
  if (!match) return;

  const arxivId = match[2];
  const arxivUrl = `https://arxiv.org/abs/${arxivId}`;

  // Create floating button
  const btn = document.createElement("button");
  btn.id = "pf-import-btn";
  btn.textContent = "Import to Arcana";
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "999999",
    padding: "10px 18px",
    background: "#4f46e5",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontWeight: "500",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
    transition: "background 0.15s, transform 0.15s",
  });

  btn.addEventListener("mouseenter", () => {
    btn.style.background = "#4338ca";
    btn.style.transform = "translateY(-1px)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "#4f46e5";
    btn.style.transform = "translateY(0)";
  });

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Importing…";
    btn.style.opacity = "0.7";
    btn.style.cursor = "wait";

    try {
      const result = await chrome.runtime.sendMessage({
        type: "import-arxiv",
        input: arxivUrl,
      });

      if (result.success) {
        const msg = result.alreadyExists
          ? "Already in Arcana"
          : "Imported to Arcana!";
        showToast(msg, "success", result.paper?.id);
        btn.textContent = "✓ Imported";
        btn.style.background = "#16a34a";
      } else {
        showToast(result.error || "Import failed", "error");
        btn.textContent = "Import to Arcana";
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
        btn.disabled = false;
      }
    } catch (err) {
      showToast("Connection failed. Is Arcana running?", "error");
      btn.textContent = "Import to Arcana";
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
      btn.disabled = false;
    }
  });

  document.body.appendChild(btn);

  // Toast notification system
  function showToast(message, type, paperId) {
    const existing = document.getElementById("pf-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "pf-toast";
    const isSuccess = type === "success";

    toast.innerHTML = `
      <span>${message}</span>
      ${paperId ? `<a href="http://localhost:3000/papers/${paperId}" target="_blank" style="color: #fff; margin-left: 8px; text-decoration: underline;">View →</a>` : ""}
    `;

    Object.assign(toast.style, {
      position: "fixed",
      bottom: "70px",
      right: "20px",
      zIndex: "999999",
      padding: "12px 18px",
      background: isSuccess ? "#16a34a" : "#dc2626",
      color: "#fff",
      borderRadius: "8px",
      fontSize: "14px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
      display: "flex",
      alignItems: "center",
      opacity: "0",
      transition: "opacity 0.2s",
    });

    document.body.appendChild(toast);
    // Trigger fade-in
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
    });

    // Update link href with actual baseUrl
    if (paperId) {
      chrome.storage.sync.get({ baseUrl: "http://localhost:3000" }, ({ baseUrl }) => {
        const link = toast.querySelector("a");
        if (link) link.href = `${baseUrl}/papers/${paperId}`;
      });
    }

    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 200);
    }, 5000);
  }
})();

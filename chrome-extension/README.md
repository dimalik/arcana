# Arcana Chrome Extension

Browser extension for importing papers into Arcana directly from arXiv, OpenReview, publisher pages, and PDF files.

## Features

- **One-click import** from arXiv, OpenReview, DOI pages, and any URL
- **Floating import button** injected on arXiv and OpenReview pages
- **PDF viewer** with annotations, highlights, area screenshots, and LLM chat
- **Auto-redirect** Arcana PDFs to the built-in viewer
- **Import history** tracked in the popup

## Install (development)

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this `chrome-extension/` directory

The extension icon appears in your toolbar. Click it to open the popup.

## Usage

### Import from arXiv / OpenReview

Navigate to any arXiv or OpenReview page. A floating "Import to Arcana" button appears at the bottom right. Click it to import the paper with full metadata.

Alternatively, click the extension icon and use the popup import button.

### Import from any page

On any webpage with a DOI or PDF, click the extension icon. It auto-detects:
- **arXiv** pages (`arxiv.org/abs/...` or `arxiv.org/pdf/...`)
- **OpenReview** pages (`openreview.net/forum?id=...`)
- **DOI links** on publisher pages
- **PDF files** (`.pdf` URLs or `application/pdf` content type)
- **Generic URLs** — imports via URL with metadata extraction

### PDF viewer

When you open a PDF served by Arcana, the extension auto-redirects to its built-in viewer with:
- Page navigation and zoom
- Text selection highlights (yellow, green, blue, pink)
- Area screenshot tool for figures/tables
- LLM chat panel — ask questions about selected text or screenshots
- Annotations sync back to Arcana

Disable auto-redirect in the popup settings if preferred.

### Settings

Click the extension icon → expand **Settings**:
- **Arcana URL** — defaults to `http://localhost:3000`, change if running elsewhere
- **Auto-open PDFs** — toggle the automatic PDF viewer redirect

## Architecture

```
manifest.json          Manifest V3 config, permissions, content script matching
background.js          Service worker: PDF redirect, import history, messaging
popup.html/js/css      Extension popup: import UI, health check, settings
content-arxiv.js       Content script: floating button on arxiv.org
content-openreview.js  Content script: floating button on openreview.net
content-pdf.js         Content script: detects PDFs for generic import
viewer.html/js/css     Full PDF viewer with annotations and LLM integration
lib/pdfjs/             Bundled pdf.js for the viewer
icons/                 Extension icons (16/48/128px)
```

## API endpoints used

The extension communicates with Arcana's local server:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Connection check |
| `/api/papers/import/arxiv` | POST | Import arXiv paper |
| `/api/papers/import/openreview` | POST | Import OpenReview paper |
| `/api/papers/import/url` | POST | Import from URL/DOI |
| `/api/papers/[id]/file` | GET | Serve PDF file |
| `/api/papers/[id]/annotations` | GET/POST | Sync annotations |
| `/api/papers/[id]/chat` | POST | LLM chat about paper |

## Permissions

- `activeTab` — read current tab URL for import detection
- `storage` — persist settings and import history
- `scripting` — inject content scripts and detect PDF content type
- `webNavigation` — auto-redirect Arcana PDFs to viewer
- `host_permissions: <all_urls>` — import from any publisher page
- `host_permissions: localhost:3000` — communicate with local Arcana server

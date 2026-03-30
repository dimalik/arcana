# API Reference

All API routes live under `src/app/api/`. The application is designed for local use — there is no rate limiting or external API authentication beyond the session cookie.

## Papers

### Core
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/papers` | List papers with pagination, filtering, sorting |
| POST | `/api/papers` | Create a paper manually |
| GET | `/api/papers/[id]` | Get paper details |
| PATCH | `/api/papers/[id]` | Update paper metadata |
| DELETE | `/api/papers/[id]` | Delete a paper |

### Import
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/papers/import/arxiv` | Import from arXiv ID |
| POST | `/api/papers/import/url` | Import from URL |
| POST | `/api/papers/import/openreview` | Import from OpenReview |
| POST | `/api/papers/import/anthology` | Import from ACL Anthology |
| POST | `/api/papers/upload` | Upload a PDF file |

### LLM Operations
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/papers/[id]/llm/summarize` | Generate structured summary |
| POST | `/api/papers/[id]/llm/extract` | Extract key findings and methods |
| POST | `/api/papers/[id]/llm/code` | Generate code from methods |
| POST | `/api/papers/[id]/llm/categorize` | Auto-tag the paper |
| POST | `/api/papers/[id]/llm/custom` | Run a custom prompt |
| POST | `/api/papers/[id]/llm/gap-finder` | Identify research gaps |
| POST | `/api/papers/[id]/llm/compare-methodologies` | Compare methods across papers |
| POST | `/api/papers/[id]/llm/timeline` | Generate development timeline |
| POST | `/api/papers/[id]/llm/rewrite-section` | Rewrite a section |

### Conversations
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/papers/[id]/conversations` | List conversations for a paper |
| POST | `/api/papers/[id]/conversations` | Create a new conversation |
| GET | `/api/papers/[id]/conversations/[convId]` | Get conversation with messages |
| DELETE | `/api/papers/[id]/conversations/[convId]` | Delete a conversation |
| POST | `/api/papers/[id]/conversations/[convId]/chat` | Send a chat message (SSE stream) |

### References & Concepts
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/papers/[id]/references` | List extracted references |
| POST | `/api/papers/[id]/references/extract` | Extract references from full text |
| GET | `/api/papers/[id]/concepts` | List concept hierarchy |
| POST | `/api/papers/[id]/concepts/[conceptId]/expand` | Expand a concept with LLM |

### Engagement
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/papers/[id]/engagement` | Record an engagement event |
| GET | `/api/papers/[id]/figures` | Get extracted figures/tables |

## Research

### Projects
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/research` | List research projects |
| POST | `/api/research` | Create a new project |
| GET | `/api/research/[id]` | Get project details (includes approaches, results, gates) |
| PATCH | `/api/research/[id]` | Update project |
| DELETE | `/api/research/[id]` | Delete project |
| POST | `/api/research/[id]/export` | Export project as JSON |
| POST | `/api/research/import` | Import a project from JSON |

### Agent
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/research/[id]/agent` | Start agent session (SSE stream) |
| POST | `/api/research/[id]/restart` | Restart a stopped agent |

### Steps
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/research/[id]/steps` | List steps for current iteration |
| POST | `/api/research/[id]/steps` | Create a manual step |
| PATCH | `/api/research/[id]/steps/[stepId]` | Update step (skip, execute, restore) |

### Hypotheses
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/research/[id]/hypotheses` | List hypotheses |
| POST | `/api/research/[id]/hypotheses` | Create a hypothesis |
| PATCH | `/api/research/[id]/hypotheses/[hypId]` | Update hypothesis status/evidence |

### Research Log
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/research/[id]/log` | Get research log entries |

### Research Chat
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/research/[id]/chat` | Chat about project findings (SSE stream, with retrieval + vision) |

### Files, Figures & Remote
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/research/[id]/files` | List experiment files (tree structure) |
| GET | `/api/research/[id]/files?path=...` | Read a specific file |
| GET | `/api/research/[id]/figures` | List project figures (Artifact records) |
| GET | `/api/research/[id]/agent-tasks` | List sub-agent tasks |
| GET | `/api/research/remote-hosts` | List configured remote hosts |
| GET | `/api/research/remote-hosts/[hostId]` | Get host details |
| PATCH | `/api/research/remote-hosts/[hostId]` | Update host config (base requirements, env notes) |
| GET | `/api/research/remote-hosts/ssh-config` | List SSH config aliases |
| GET | `/api/research/remote-jobs` | List remote jobs |
| GET | `/api/research/remote-jobs/[jobId]` | Get job details (includes errorClass, fixAttempts) |

### Benchmark
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/research/benchmark` | List benchmark projects |
| POST | `/api/research/benchmark` | Create a benchmark project |
| POST | `/api/research/benchmark/evaluate` | Run benchmark evaluation |
| GET | `/api/research/benchmark/judges` | List benchmark judges |

## Mind Palace

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mind-palace/rooms` | List rooms |
| POST | `/api/mind-palace/rooms` | Create a room |
| PATCH | `/api/mind-palace/rooms/[id]` | Update a room |
| DELETE | `/api/mind-palace/rooms/[id]` | Delete a room |
| GET | `/api/mind-palace/insights` | List insights (filterable by room) |
| POST | `/api/mind-palace/insights` | Create an insight |
| PATCH | `/api/mind-palace/insights/[id]` | Update an insight |
| DELETE | `/api/mind-palace/insights/[id]` | Delete an insight |
| POST | `/api/mind-palace/insights/distill` | Auto-distill insights from a paper |
| GET | `/api/mind-palace/review` | Get insights due for review |
| POST | `/api/mind-palace/review` | Submit a review result |

## Synthesis

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/synthesis` | List synthesis sessions |
| POST | `/api/synthesis` | Create a new synthesis |
| GET | `/api/synthesis/[id]` | Get synthesis details |
| POST | `/api/synthesis/[id]/execute` | Start synthesis generation |
| POST | `/api/synthesis/[id]/export` | Export to PDF or LaTeX |

## Discovery

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/discovery` | Start a discovery session from seed papers |
| GET | `/api/discovery/[id]` | Get discovery results |
| POST | `/api/discovery/[id]/import` | Import a discovered paper |
| POST | `/api/discovery/[id]/dismiss` | Dismiss a proposal |

## Other

### Collections
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/collections` | List collections |
| POST | `/api/collections` | Create a collection |
| PATCH | `/api/collections/[id]` | Update a collection |
| DELETE | `/api/collections/[id]` | Delete a collection |
| POST | `/api/collections/[id]/papers` | Add paper to collection |

### Tags
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tags` | List tags with clusters |
| POST | `/api/tags/cluster` | Auto-cluster tags |
| POST | `/api/tags/merge` | Merge duplicate tags |

### Search
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search?q=...` | Full-text search across papers |

### Notebook
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notebook` | List notebook entries |
| POST | `/api/notebook` | Create an entry |
| DELETE | `/api/notebook/[id]` | Delete an entry |

### Settings
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings/model` | Get current model configuration |
| POST | `/api/settings/model` | Update model configuration |
| GET | `/api/settings/agent/capabilities` | List agent capabilities |
| POST | `/api/settings/agent/capabilities` | Create a capability |

### Admin
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/usage` | LLM usage statistics (with per-paper and per-project breakdowns) |
| GET | `/api/admin/events` | Application event logs |
| GET | `/api/admin/users` | User management |
| POST | `/api/admin/repair-pdfs` | Batch repair missing/broken PDFs |

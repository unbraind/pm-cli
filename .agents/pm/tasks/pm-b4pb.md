{
  "id": "pm-b4pb",
  "title": "Make semantic search fully working using Ollama",
  "description": "Update Ollama provider to use /api/embed for batch inputs to allow qwen3-embedding:0.6b to index correctly.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search",
    "milestone:4",
    "pm-cli",
    "priority:1",
    "semantic"
  ],
  "created_at": "2026-03-09T00:05:54.250Z",
  "updated_at": "2026-03-09T00:06:18.731Z",
  "deadline": "2026-03-10T00:05:54.250Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "pm reindex --mode semantic correctly batches strings to Ollama and successfully indexes the repository",
  "comments": [
    {
      "created_at": "2026-03-09T00:05:54.250Z",
      "author": "maintainer-agent",
      "text": "Why this exists: semantic search via ollama is failing with cardinality mismatch."
    },
    {
      "created_at": "2026-03-09T00:06:17.890Z",
      "author": "maintainer-agent",
      "text": "Evidence: Tests pass and semantic indexing correctly batches to Ollama /api/embed endpoint. Coverage is 100%."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-09T00:05:54.250Z",
      "author": "maintainer-agent",
      "text": "Will update providers.ts and tests."
    }
  ],
  "files": [
    {
      "path": "src/core/search/providers.ts",
      "scope": "project",
      "note": "fixed endpoint"
    },
    {
      "path": "tests/unit/embedding-provider.spec.ts",
      "scope": "project",
      "note": "updated test assertions"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "sandbox-safe regression"
    }
  ],
  "close_reason": "Tests passed and semantic indexing correctly batches to Ollama /api/embed endpoint"
}

Using /api/embeddings did not support batching correctly for qwen3-embedding:0.6b in Ollama. Switching to /api/embed allows us to pass multiple inputs and get multiple vectors back, fixing the cardinality mismatch error.

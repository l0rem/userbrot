# Agentic RAG Plan

Last updated: 2026-02-19

## Goal

Improve bot answer quality from one-shot global RAG to a multi-step, tool-using planner that:

- decides when retrieval is needed,
- selects relevant chats first,
- searches messages iteratively,
- reasons over evidence with uncertainty handling.

## Confirmed Findings

### Current system limitations

- Q&A path is currently one-shot retrieval + answer (`packages/core/src/services/ragService.ts`).
- Bot still has `/ask` command (`packages/bot/src/index.ts`).
- Retrieval is global and semantic-first, so it can pick wrong chat context for personal-entity questions.

### Why wrong answers happen (example: mom birthday)

- No chat selection stage before retrieval.
- No role-aware interpretation (my messages vs partner messages).
- No hybrid lexical + semantic retrieval and no reranker to correct near-miss evidence.

## Architecture Direction

Use an agentic retrieval workflow with explicit tools and bounded loops.

### Core tools

1. `find_candidate_chats(question)`
   - returns likely chat IDs with scores and short reasons.
2. `search_messages(params)`
   - params include `chatIds`, `query`, `speaker` (`me`/`other`/`any`), `timeRange`, `topK`.
3. `expand_context(params)`
   - fetches local message windows around evidence hits.
4. `finalize_answer(params)`
   - synthesizes answer with confidence and citations from the gathered evidence.

### Retrieval strategy

- Hybrid retrieval: semantic vectors + lexical signals.
- Fuse/rank combined results (RRF-style or weighted rank fusion).
- Optional rerank pass on top-N candidates before final synthesis.

### Reasoning and safety

- Agent chooses whether retrieval is needed; not every question should hit RAG.
- Multi-step planning with stop limits (max tool calls / max iterations).
- Contradiction detection and low-evidence fallback.
- Confidence output and brief uncertainty statement when evidence is weak.

### Personal-memory bias controls

- For first-person personal queries, prioritize evidence from user's own messages.
- Down-rank conflicting first-person statements from other participants unless question explicitly asks about them.
- Use chat-level priors from title/username and interaction density to identify likely people (e.g., girlfriend chat).

## Interaction Behavior Plan

### Input surface

- Remove `/ask`; plain text becomes the only ask path.

### Observability

- Log which streaming path was used (`draft` vs `edit`) and why fallback occurred.
- Log retrieval plan steps and selected chats for debugging.

## Implementation Phases

### Phase 1: UX and control flow

- Remove `/ask` command and docs references.

### Phase 2: Retrieval quality foundation

- Add chat candidate selection stage.
- Add hybrid retrieval (semantic + lexical).
- Add rerank for top-N evidence.

### Phase 3: Agentic loop

- Implement bounded tool-calling loop in core service.
- Add query rewrite / follow-up retrieval step when evidence is insufficient.
- Add final answer synthesis with confidence + citations.

### Phase 4: Evaluation and tuning

- Build a personal-memory eval set (facts, dates, relationship context, ambiguous phrasing).
- Track metrics:
  - chat selection accuracy,
  - retrieval precision@k,
  - answer factuality,
  - uncertainty correctness,
  - latency.

## Open Decisions (for later)

1. Low-evidence response mode:
   - strict refusal, or
   - best-guess with explicit confidence and uncertainty.
2. Reranker choice:
   - provider-native reranker,
   - separate rerank model,
   - or no rerank in v1.
3. Amount of visible reasoning:
   - internal logs only,
   - or user-facing mini status updates.

## External References

- OpenRouter tool calling:
  - https://openrouter.ai/docs/guides/features/tool-calling
- Anthropic guide: building effective agents:
  - https://www.anthropic.com/engineering/building-effective-agents
- LangGraph tutorial: agentic RAG:
  - https://docs.langchain.com/oss/python/langgraph/agentic-rag
- Hybrid retrieval and rank fusion overview:
  - https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview
  - https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking
- Rerank overview (cross-encoder style reranking motivation):
  - https://docs.cohere.com/docs/rerank-overview

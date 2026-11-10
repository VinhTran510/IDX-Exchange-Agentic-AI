# Week 6: Embeddings and Semantic Search

The assistant can now find listings by meaning, not just by filters. A request like "charming craftsman with character" or "cozy place with a big backyard for dogs" returns the active listings whose written descriptions are closest in meaning, even when they share none of those exact words.

## What was built

- **Index builder** (`scripts/buildEmbeddingIndex.ts`): reads active listings, embeds each description with Gemini, and saves the vectors to a local, git-ignored folder. It is resumable: re-running it skips listings that are already embedded.
- **Embedding client** (`src/embeddingClient.ts`): calls the Gemini embeddings API in batches, retries rate limits with growing waits, and normalizes the vectors.
- **Listing text** (`src/listingText.ts`): builds the text that is embedded and cleans it first.
- **Vector index** (`src/vectorIndex.ts`): an on-disk index with brute-force cosine similarity.
- **Semantic search** (`src/semanticSearch.ts`) and the **`semantic-search` skill** (`skills/semantic-search/`): structured filters first, ranking by meaning second, returning the top five listings as the same cards as before.
- **Inspection tool** (`scripts/inspectMatches.ts`): a developer-only script that shows similarity scores and description snippets, so ranking quality can be judged by reading real matches.

## Design decisions

**Gemini embeddings instead of OpenAI.** The handbook uses OpenAI's embedding model. The project runs on Gemini, which the program allows, so the index uses `gemini-embedding-001` with one API key already in use. Vectors are reduced to 768 dimensions, which the model supports with little loss of quality, and normalized to unit length so cosine similarity becomes a plain dot product.

**Node and a brute-force search instead of Python, scikit-learn and a vector database.** The rest of the project is TypeScript, and ranking tens of thousands of vectors with a dot product takes milliseconds. A vector database would add moving parts without solving a problem this size has.

**Filters first, meaning second.** If the request contains city, price, bedrooms, pool, view or HOA wording, those are applied in SQL as hard requirements and only the survivors are ranked by similarity. "Craftsman in Pasadena under $2M" can therefore never return a listing in another city or above the budget.

**Descriptions are cleaned before embedding and never shown.** Listing descriptions are free text written by agents. Phone numbers, emails and links are stripped before embedding, and the skill prints only the structured cards (address, price, beds/baths, photo count). That keeps contact details out of the chat, and it also means text inside a description can never reach the AI model as an instruction.

**Price is not embedded.** Price is handled exactly by SQL filters, and embedding it would make results drift as prices change.

**A resumable, crash-tolerant index.** Vectors are appended in batches, and on startup the index repairs itself by keeping only rows that have both an id and a full vector. A long build can be stopped, hit a rate limit, or crash without losing finished work. The index also refuses to load with a different model or vector size than it was built with.

**Judge ranking by reading, not by scores.** Similarity scores for good and mediocre matches sit close together, so they are not shown to users. The inspection script prints scores with the matching description snippets, and quality was judged by reading the top results for several queries. Top results were clearly the right kind of home, such as an early-1900s Craftsman bungalow for the craftsman query and a contemporary open-plan house for the entertaining query.

## Testing

- **Offline unit tests** (13 new, 43 total): contact-detail stripping, prices and years not mistaken for phone numbers, batching by 100 with the correct task types, retries on rate limits, API keys never in URLs or error messages, a response with the wrong vector size rejected, index append, reload, ranking and filtering, repair of a half-written batch, refusal of a mismatched index, SQL built with bound parameters only, and the full search path with a fake embedder and database.
- **Small build first:** a 200-listing index for one city validated the real API, the cleaning and the ranking before spending anything on the full build.
- **Full build:** the whole active-listings table was embedded for a few dollars, with the retry logic handling the API's per-minute limits.
- **Terminal and WhatsApp searches** using descriptions in plain words, with and without city and price filters.

## Known limits

- The index is a snapshot. Re-running the builder adds new listings but does not remove old ones. Listings that are no longer active drop out of results at lookup time, so a search can occasionally return fewer than five cards until the index is refreshed.
- Ranking is approximate and depends on how the listing agent wrote the description.
- Words like "view" or "pool" in a request are treated as hard filters, which is usually what people want but means the semantic part only ranks the matching listings.
- Each search makes one embedding request, adding a small delay and a tiny cost.
- Semantic search returns individual listings. It does not combine with the conversational memory of the regular search yet.
# Document Chatbot

Customers chat with an AI agent that answers **only from the documents you upload**.
Works with any model API (OpenAI-compatible, Anthropic, Gemini). Keys stay on the server.

**Stack:** Node 18+, Express, SQLite (FTS5 search), JWT cookie auth, plain HTML/JS frontend. No build step.

## Run
```bash
npm install
cp .env.example .env      # set JWT_SECRET and ENCRYPTION_KEY (openssl rand -hex 32)
npm start                 # http://localhost:3000
```
1. Open `/admin`, create the admin account (the first account is always allowed).
2. **New agent** → Settings: pick provider, model, paste API key.
3. **Documents**: upload PDF, DOCX, TXT, MD, CSV, JSON, HTML.
4. **Share**: send customers `/c/<slug>` or paste the iframe embed code on your site.
5. **Conversations**: review what customers asked and which documents answered.

## How answers are produced
- Small knowledge bases (≤ 30k characters) are sent to the model in full.
- Larger ones: the model first rewrites the question into a standalone search query using the chat history (intent step), SQLite FTS5/BM25 retrieves the top passages, then the model answers from them only.
- The system prompt forbids outside knowledge, handles greetings and ambiguity, and replies in the customer's language (Arabic/English).

## API
| Method | Path | Auth |
|---|---|---|
| POST | `/api/auth/register`, `/login`, `/logout` · GET `/me`, `/status` | – |
| GET/POST | `/api/bots` · PUT/DELETE `/api/bots/:id` | admin |
| GET/POST | `/api/bots/:id/documents` · DELETE `/api/documents/:id` | admin |
| GET | `/api/bots/:id/conversations` · `/api/conversations/:id/messages` | admin |
| GET | `/api/public/:slug` · POST `/api/public/:slug/chat` `{session,message}` | public, rate-limited |

## Production notes
- Set `NODE_ENV=production` (secure cookies, needs HTTPS) and `TRUST_PROXY=true` behind a proxy.
- Back up `data.db`. Keep `ENCRYPTION_KEY` stable, or saved API keys can't be decrypted.
- Scanned PDFs have no text layer and need OCR before upload.

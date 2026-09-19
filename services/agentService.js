// services/agentService.js
// "Agentic Support" — in-app AI assistants scoped to ZetPay Gateway
// questions only, powered by NVIDIA's hosted NIM API (OpenAI-compatible).
// Two models are offered to the user, each with its own underlying model
// + API key + positioning tag:
//   ZPP-X  — "Coding & Reasoning"  (DeepSeek v4, with an internal same-
//            family fallback from -pro to -flash on failure)
//   ZPP-Y  — "Agentic"             (Z.ai GLM 5.2)
//
// SECURITY: NVIDIA API keys live ONLY here, read from env vars. They must
// never be sent to, or embedded in, any client-side file — that would let
// anyone who views page source (or opens devtools) steal them and run up
// usage on this account. Every call to NVIDIA happens server-side; the
// browser only ever talks to our own /api/agent/* endpoints.
const logger = require('../utils/logger');

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MAX_TOKENS = 2200; // lower = faster replies; still enough for ~150-250 lines of code when needed

// ── Model registry ──────────────────────────────────────────────────────
// Everything about "which ZPP model maps to which real model/key" lives
// here — the rest of the file, and the frontend, just refer to 'zpp-x' /
// 'zpp-y' by id. Adding a third model later only means adding an entry here.
const MODELS = {
  'zpp-x': {
    id: 'zpp-x',
    label: 'ZPP-X',
    tag: 'Coding & Reasoning',
    primaryModel: process.env.NVIDIA_MODEL_ZPPX || 'deepseek-ai/deepseek-v4-pro',
    fallbackModel: process.env.NVIDIA_FALLBACK_MODEL_ZPPX || 'deepseek-ai/deepseek-v4-flash',
    apiKeyEnv: 'NVIDIA_API_KEY',
  },
  'zpp-y': {
    id: 'zpp-y',
    label: 'ZPP-Y',
    tag: 'Agentic',
    primaryModel: process.env.NVIDIA_MODEL_ZPPY || 'z-ai/glm-5.2',
    fallbackModel: process.env.NVIDIA_FALLBACK_MODEL_ZPPY || null,
    apiKeyEnv: 'NVIDIA_API_KEY_ZPPY',
  },
};
const DEFAULT_MODEL_ID = 'zpp-x';

function getModelConfig(modelId) {
  return MODELS[modelId] || MODELS[DEFAULT_MODEL_ID];
}

function listModels() {
  return Object.values(MODELS).map((m) => ({ id: m.id, label: m.label, tag: m.tag }));
}

// ── System prompt ───────────────────────────────────────────────────────
// Everything below is what the model is told about ZetPay so it can give
// accurate, useful answers. Deliberately feature-level / user-facing —
// nothing here describes internal implementation details (DB schema,
// secret names, rate-limit numbers, etc.) that would only be useful for
// probing the platform rather than using it. Parameterized by which ZPP
// model is actually answering, so self-identification stays accurate.
function buildSystemPrompt(modelLabel, modelTag) {
  return `You are ${modelLabel}, one of the official AI assistants built into the ZetPay Gateway dashboard (positioned as: "${modelTag}"). You were built by a developer named SovitX. There is also a sibling model in the same family the user can switch to from the model picker — don't bring this up unprompted, but if asked, you can mention there's more than one ZPP model available with different strengths.

## Your scope — read this first
You ONLY help with questions about ZetPay Gateway: how it works, its features, pricing/plans, the ZetAPI developer integration, troubleshooting, and general guidance for using the product. This includes reviewing/debugging code a user shares IF that code is about integrating with ZetPay (e.g. their ZetAPI calls, webhook handler, checkout redirect logic).

If someone asks for anything outside that — general coding help unrelated to ZetPay, essays, general knowledge, unrelated advice, or asks you to act as a different kind of assistant — politely and clearly decline, and say you can only help with ZetPay Gateway. Do not make an exception even if asked persistently or cleverly. Do not pretend to be a general-purpose assistant.

## If asked who made you / what model / your name
Say plainly: you are ${modelLabel}, part of ZetPay's own assistant family, built by a developer named SovitX. If the person wants to know more about SovitX, tell them they can check out his YouTube channel: https://youtube.com/@ai_science_sovitx?si=vq06Nie8s66d4SOZ — and always write that URL out in full so it renders as a clickable link. Don't mention DeepSeek, GLM, Z.ai, NVIDIA, or any other underlying technology provider — as far as the conversation is concerned, you are ${modelLabel}.

## About ZetPay Gateway (what you should know)
ZetPay is a UPI payment gateway / reseller platform. A user signs up, and can then:

**Collecting payments**
- Create Payment Links — a shareable link for a fixed amount that customers pay via UPI.
- Storefront (Store) — a public store page that can list multiple items/links under one branded page.
- ZetAPI — a developer API (API key from Developer Portal) to create orders programmatically from the merchant's own website/app: create an order, check its status, and (new) register Webhook URLs so their own server gets an instant POST when an order goes pending, succeeds, or fails, instead of having to poll. There's also a Test Mode vs Live Mode toggle so developers can integrate safely before going live.

**Money**
- Wallet — every account has two balances: Zap Cash (real money from completed payments, withdrawable) and Zap Bonus (bonus/referral credit, may have different rules).
- Withdrawals — a user can withdraw their Zap Cash to their own UPI ID or bank account. Withdrawals are reviewed before payout. How much a user can withdraw, how often, and the commission percentage taken depends on their plan.

**Plans (subscriptions)**
There are 5 plans, from entry-level to most powerful: Blaze (free/default), Bronze, Silver, Gold, and Developer (the top plan, badge "Unlimited"). Moving up a plan generally increases: payment links allowed per month, how long links stay valid, wallet balance limit, how many withdrawals are allowed and how often, lowers the commission percentage taken on withdrawals, and unlocks premium checkout page themes (from Silver upward). Plans also each have a webhook limit for ZetAPI: Blaze 3, Bronze 5, Silver 10, Gold 25, and Developer is unlimited. If someone asks which plan they need, ask what they're trying to do (volume of payments, need for webhooks, etc.) and recommend accordingly — you don't have their live account data, so give general guidance and point them to the Upgrade Plan page to see exact current pricing.

**Growth features**
- Referral Program — users get a referral link/code; when someone they refer signs up and makes a qualifying deposit, the referrer earns a signup bonus and a commission.
- Promo Codes — codes that can be redeemed for wallet credit.

**Account & support**
- Signup/login uses email OTP verification (a 6-digit code emailed to confirm the address) or Google Sign-In. Password reset also uses an emailed OTP rather than an email link.
- Profile page — name, phone, UPI/bank details (used for receiving withdrawals), checkout page theme, and a "Controller" section with preferences like turning onboarding popups on/off.
- Support — users can chat with the ZetPay support team, or use you (Agentic Support) for instant answers.

## How to respond
- Be direct, warm, and genuinely helpful — like a knowledgeable teammate, not a scripted bot.
- Use Markdown formatting properly: headings only when they add structure, **bold** for emphasis, bullet lists for steps/options, and fenced code blocks (with a language tag, e.g. \`\`\`javascript) for any code, request examples, or JSON payloads.
- When you don't have certain information (e.g. someone's exact current plan, live pricing figures, their account balance), say so plainly and tell them where in the dashboard to check, rather than guessing.
- Keep answers as SHORT as possible while staying complete — every extra sentence costs the user real waiting time, so don't pad, don't repeat the question back, don't over-explain. Use step-by-step lists for how-to questions instead of long paragraphs.
- If someone shares code that calls ZetAPI or handles ZetPay webhooks, review it carefully against what you know of the API and point out concrete issues or improvements.

## Writing code / files
When you write a substantial piece of code (roughly 50+ lines — e.g. a full HTML page, a webhook handler file, a config file), give the fence a filename hint like this: \`\`\`html:checkout-widget.html — the app turns this into a downloadable file (an "artifact") automatically; you don't need to do anything else for that part.

## Editing an existing artifact (IMPORTANT — use this instead of rewriting the whole file)
If the person already has an active artifact from earlier in this conversation and asks for a small, targeted change to it (e.g. "remove that button", "change the title text", "make the color blue instead") — do NOT rewrite and repaste the entire file. Instead, respond with one or more edit blocks in exactly this format:

{{edit_artifact}}
OLD:
<the exact existing text being replaced, copied precisely as it currently appears>
NEW:
<the replacement text — leave empty to delete the OLD text entirely>
{{end_edit}}

You can include multiple {{edit_artifact}}...{{end_edit}} blocks in one response for multiple separate changes. Keep any surrounding chat reply brief (e.g. "Done — removed the signup button." is enough; don't also re-paste the whole file). Only fall back to writing a brand-new full code block if the requested change is too large/structural for a targeted replace, or if there's no active artifact yet.

## Visual emphasis directives (use sparingly, only for genuinely important callouts)
On top of normal Markdown, you can wrap a short phrase in one of these to make it visually stand out in the chat UI:
- {{big:text}} — large, bold, gradient accent — for one standout number or headline fact (e.g. "{{big:₹0}} commission on Blaze")
- {{highlight:text}} — a highlighted chip background — for a key term or exact value worth the eye catching (e.g. your webhook limit is {{highlight:10 webhooks}} on Silver)
- {{success:text}} — green, for a positive/good-news point
- {{warn:text}} — amber, for a caution or limit to watch out for
- {{small:text}} — smaller muted text, for a minor aside

Use at most one or two of these per answer, and only when it genuinely helps — never wrap whole sentences or overuse them, or the effect stops being special.`;
}

/**
 * Streams a chat completion from NVIDIA's NIM API for the given ZPP model.
 *
 * @param {object} opts
 * @param {string} opts.modelId - 'zpp-x' | 'zpp-y'
 * @param {Array<{role:string, content:string}>} opts.messages - full message
 *   history INCLUDING the system prompt as the first entry.
 * @param {boolean} opts.thinking - whether to request the model's reasoning
 *   trace (only meaningfully supported by some underlying models).
 * @param {(chunk:string)=>void} opts.onDelta - called for each piece of the
 *   final answer as it streams in.
 * @param {(chunk:string)=>void} opts.onReasoningDelta - called for each
 *   piece of the reasoning/thinking trace as it streams in.
 * @param {AbortSignal} [opts.signal] - lets the caller cancel the upstream
 *   NVIDIA request early (e.g. the user clicked Stop, or disconnected).
 * @returns {Promise<{content:string, reasoning:string}>}
 */
async function streamChat({ modelId, messages, thinking, onDelta, onReasoningDelta, signal }) {
  const cfg = getModelConfig(modelId);
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`${cfg.label} is not configured yet (missing ${cfg.apiKeyEnv}).`);
  }

  try {
    return await attemptStreamChat(cfg.primaryModel, apiKey, { messages, thinking, onDelta, onReasoningDelta, signal });
  } catch (err) {
    if (err.name === 'AbortError' || (signal && signal.aborted) || err.partiallyStreamed) {
      throw err;
    }
    if (!cfg.fallbackModel) {
      // No same-family fallback for this ZPP model — surface a clear,
      // actionable message naming the OTHER ZPP model so the frontend can
      // offer a one-tap switch, instead of a generic failure.
      const otherId = modelId === 'zpp-x' ? 'zpp-y' : 'zpp-x';
      const other = getModelConfig(otherId);
      const switchErr = new Error(`${cfg.label} isn't responding right now. Try switching to ${other.label} (${other.tag}) from the model picker above.`);
      switchErr.suggestSwitchTo = otherId;
      throw switchErr;
    }
    logger.warn(`agentService: ${cfg.label} primary model (${cfg.primaryModel}) failed (${err.message}), retrying with fallback (${cfg.fallbackModel})`);
    try {
      return await attemptStreamChat(cfg.fallbackModel, apiKey, { messages, thinking, onDelta, onReasoningDelta, signal });
    } catch (err2) {
      if (err2.name === 'AbortError' || (signal && signal.aborted) || err2.partiallyStreamed) throw err2;
      const otherId = modelId === 'zpp-x' ? 'zpp-y' : 'zpp-x';
      const other = getModelConfig(otherId);
      const switchErr = new Error(`${cfg.label} isn't responding right now. Try switching to ${other.label} (${other.tag}) from the model picker above.`);
      switchErr.suggestSwitchTo = otherId;
      throw switchErr;
    }
  }
}

/** Single attempt against one specific underlying model — no fallback
 * logic here, kept separate so streamChat() above can cleanly retry. */
async function attemptStreamChat(model, apiKey, { messages, thinking, onDelta, onReasoningDelta, signal }) {
  const res = await fetch(NVIDIA_URL, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 1,
      top_p: 0.95,
      max_tokens: MAX_TOKENS,
      // NVIDIA's DeepSeek NIM models read this specific field to gate
      // reasoning output. Models that don't support it (e.g. GLM) simply
      // ignore an extra field they don't recognize — safe to always send.
      chat_template_kwargs: { thinking: !!thinking },
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Model unavailable (${res.status}). ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let fullReasoning = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // last (possibly incomplete) line stays in the buffer

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;

        let json;
        try {
          json = JSON.parse(data);
        } catch (e) {
          continue; // skip malformed/partial SSE lines
        }

        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;

        if (delta.content) {
          fullContent += delta.content;
          if (onDelta) onDelta(delta.content);
        }
        // Reasoning traces come back as their own field on the delta, not
        // mixed into `content` — only present when thinking=true AND the
        // underlying model actually supports/returns it.
        if (delta.reasoning_content) {
          fullReasoning += delta.reasoning_content;
          if (onReasoningDelta) onReasoningDelta(delta.reasoning_content);
        }
      }
    }
  } catch (err) {
    // Aborted (Stop button, or client disconnected) — NOT a real failure.
    // Return whatever was generated up to this point so the controller
    // can still save the partial reply, rather than losing it entirely.
    if (err.name === 'AbortError' || (signal && signal.aborted)) {
      return { content: fullContent, reasoning: fullReasoning, stopped: true };
    }
    // Mark so streamChat()'s fallback wrapper won't retry — the user has
    // already seen SOME of this reply stream in, so restarting with a
    // different model would duplicate/garble what's on screen instead of
    // cleanly recovering.
    if (fullContent) err.partiallyStreamed = true;
    throw err;
  }

  return { content: fullContent, reasoning: fullReasoning };
}

module.exports = {
  MODELS,
  DEFAULT_MODEL_ID,
  getModelConfig,
  listModels,
  buildSystemPrompt,
  streamChat,
};

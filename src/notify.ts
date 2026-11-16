import { NotifyConfig } from "./config.js";
import { NotifyEvent, NotifyService } from "./enums.js";
import { clip, mask } from "./log.js";

const TIMEOUT_MS = 10_000;

interface TelegramBody {
  chat_id: string;
  text: string;
}

interface SlackBody {
  text: string;
}

// allowed_mentions with no parse types: "@everyone" or "<@id>" in a ticket title pings nobody.
interface DiscordBody {
  content: string;
  allowed_mentions: { parse: string[] };
}

interface Request {
  url: string;
  body: TelegramBody | SlackBody | DiscordBody;
}

// Slack reads "<!channel>" and "<@U123>" in a message as mentions; escaped, they are plain text.
function slackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The HTTP request one service wants. A secret that is missing from the environment is an error text, not a request.
function buildRequest(cfg: NotifyConfig, text: string, env: NodeJS.ProcessEnv): Request | string {
  switch (cfg.service) {
    case NotifyService.Telegram: {
      const token = env[cfg.botTokenEnv] ?? "";
      if (token === "") return `environment variable ${cfg.botTokenEnv} is not set`;
      return { url: `${cfg.apiUrl}/bot${token}/sendMessage`, body: { chat_id: cfg.chatId, text } };
    }
    case NotifyService.Slack:
    case NotifyService.Discord: {
      const url = env[cfg.webhookUrlEnv] ?? "";
      if (url === "") return `environment variable ${cfg.webhookUrlEnv} is not set`;
      const body = cfg.service === NotifyService.Slack ? { text: slackText(text) } : { content: text, allowed_mentions: { parse: [] } };
      return { url, body };
    }
    case NotifyService.None:
      return "notifications are off";
  }
}

export function wants(cfg: NotifyConfig, event: NotifyEvent): boolean {
  return cfg.service !== NotifyService.None && cfg.events.includes(event);
}

// Send one message. Never throws: returns "" on success, otherwise a short reason for the log. The reason never
// contains the request URL, because it carries the bot token or the webhook secret.
export async function sendNotification(cfg: NotifyConfig, text: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const request = buildRequest(cfg, clip(mask(text), 1500), env);
  if (typeof request === "string") return request;
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok ? "" : `${cfg.service} answered HTTP ${response.status}`;
  } catch (error) {
    return `${cfg.service} request failed (${error instanceof Error ? error.name : "error"})`;
  }
}

// The names of environment variables the notifier needs that are not set.
export function missingEnv(cfg: NotifyConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const name = cfg.service === NotifyService.Telegram ? cfg.botTokenEnv : cfg.webhookUrlEnv;
  return cfg.service === NotifyService.None || (env[name] ?? "") !== "" ? [] : [name];
}

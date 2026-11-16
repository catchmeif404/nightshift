import { randomBytes, timingSafeEqual } from "node:crypto";
import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import { AddressInfo } from "node:net";
import { doctorChecks } from "../commands.js";
import { ConfigError, loadConfig } from "../config.js";
import { AgentType, BoardType, NoteLanguage, UiRoute } from "../enums.js";
import { mask } from "../log.js";
import { Slots, statePaths } from "../state.js";
import { renderPage } from "./page.js";
import { SettingsError, SettingsForm, checkEdit, readSettings, saveEdit } from "./settings.js";
import { snapshot } from "./snapshot.js";

// The console listens on the loopback address only; nothing else is ever bound.
export const LOOPBACK = "127.0.0.1";
export const DEFAULT_PORT = 4404;
const CSRF_HEADER = "x-nightshift-csrf";
const MAX_BODY = 64 * 1024;
const JSON_TYPE = "application/json";

export interface UiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function reply(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    ...extra,
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  reply(res, status, JSON.stringify(value), `${JSON_TYPE}; charset=utf-8`);
}

function fail(res: ServerResponse, status: number, message: string, extra: object = {}): void {
  json(res, status, { error: mask(message), ...extra });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY) throw new SettingsError("request too large", 413);
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new SettingsError("request is not valid JSON", 400);
  }
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SettingsError(`${where} must be an object`, 400);
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") throw new SettingsError(`${where} must be a string`, 400);
  return value;
}

function asStrings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new SettingsError(`${where} must be a list of strings`, 400);
  return value as string[];
}

function asEnum<T extends string>(all: readonly T[], value: unknown, where: string): T {
  const match = all.find((a) => a === value);
  if (match === undefined) throw new SettingsError(`${where} must be one of: ${all.join(", ")}`, 400);
  return match;
}

function asAgent(value: unknown, where: string): SettingsForm["builder"] {
  const o = asRecord(value, where);
  return { type: asEnum(Object.values(AgentType), o.type, `${where}.type`), model: asString(o.model, `${where}.model`) };
}

// The request body is untrusted: rebuild the form field by field, so nothing else in it can reach the config file.
export function parseForm(value: unknown): SettingsForm {
  const o = asRecord(value, "edit");
  const board = asRecord(o.board, "edit.board");
  if (!Array.isArray(o.projects)) throw new SettingsError("edit.projects must be a list", 400);
  if (typeof o.maxSlots !== "number") throw new SettingsError("edit.maxSlots must be a number", 400);
  return {
    projects: o.projects.map((p, i) => {
      const r = asRecord(p, `edit.projects[${i}]`);
      return { name: asString(r.name, `edit.projects[${i}].name`), repoPath: asString(r.repoPath, `edit.projects[${i}].repoPath`) };
    }),
    board: {
      type: asEnum(Object.values(BoardType), board.type, "edit.board.type"),
      dir: asString(board.dir, "edit.board.dir"),
      repos: asStrings(board.repos, "edit.board.repos"),
      trustedAuthors: asStrings(board.trustedAuthors, "edit.board.trustedAuthors"),
    },
    builder: asAgent(o.builder, "edit.builder"),
    reviewer: asAgent(o.reviewer, "edit.reviewer"),
    maxSlots: o.maxSlots,
  };
}

function parseEditRequest(value: unknown): { edit: SettingsForm; revision: string } {
  const o = asRecord(value, "request");
  return { edit: parseForm(o.edit), revision: asString(o.revision, "revision") };
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startUi(root: string, requestedPort: number): Promise<UiServer> {
  const csrf = randomBytes(32).toString("hex");
  let allowedHosts = new Set<string>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // A page on another site can be made to resolve to 127.0.0.1 (DNS rebinding); its Host header still differs.
    if (!allowedHosts.has(req.headers.host ?? "")) return fail(res, 403, "unexpected Host header");
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedHosts.has(origin.replace(/^http:\/\//, ""))) return fail(res, 403, "cross-origin request refused");
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return fail(res, 403, "cross-site request refused");
    const url = new URL(req.url ?? "/", "http://localhost");
    const post = req.method === "POST";
    if (req.method !== "GET" && !post) return fail(res, 405, "method not allowed");

    if (url.pathname === UiRoute.Page) {
      if (post) return fail(res, 405, "method not allowed");
      let language = NoteLanguage.English;
      try {
        language = loadConfig(root).language;
      } catch {
        // The page still opens when the config is broken: the settings panel explains it.
      }
      const nonce = randomBytes(16).toString("base64");
      const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
      return reply(res, 200, renderPage(nonce, csrf, language), "text/html; charset=utf-8", { "content-security-policy": csp });
    }

    const readOnlyRoutes: string[] = [UiRoute.Status, UiRoute.Settings];
    const writeRoutes: string[] = [UiRoute.Check, UiRoute.Save, UiRoute.Doctor];
    if (!(post ? writeRoutes : readOnlyRoutes).includes(url.pathname)) return fail(res, 404, "not found");
    if (post) {
      // Both are needed: a browser always sends Origin on POST; the token proves the caller read our own page.
      if (origin === undefined) return fail(res, 403, "missing Origin");
      if (!tokenMatches(req.headers[CSRF_HEADER] as string | undefined, csrf)) return fail(res, 403, "missing or wrong CSRF token");
      if (!(req.headers["content-type"] ?? "").startsWith(JSON_TYPE)) return fail(res, 415, `${JSON_TYPE} only`);
    }

    try {
      switch (url.pathname) {
        case UiRoute.Status:
          return json(res, 200, await snapshot(loadConfig(root)));
        case UiRoute.Settings:
          return json(res, 200, readSettings(root));
        case UiRoute.Check: {
          const { edit, revision } = parseEditRequest(await readBody(req));
          return json(res, 200, await checkEdit(root, edit, revision));
        }
        case UiRoute.Save: {
          const { edit, revision } = parseEditRequest(await readBody(req));
          const saved = saveEdit(root, edit, revision);
          // Only reports who is running; saving never starts, stops or restarts a worker.
          let runningWorkers: Array<{ target: string }> = [];
          try {
            runningWorkers = new Slots(statePaths(loadConfig(root).stateDir).slots).peek().map((s) => ({ target: s.target }));
          } catch {
            // The saved file may still carry an old problem; the save itself succeeded.
          }
          return json(res, 200, { ...saved, runningWorkers });
        }
        default: {
          await readBody(req);
          return json(res, 200, { checks: (await doctorChecks(root)).map((c) => ({ level: c.level, what: mask(c.what) })) });
        }
      }
    } catch (error) {
      if (error instanceof SettingsError) return fail(res, error.status, error.message, { issues: error.issues });
      if (error instanceof ConfigError) return fail(res, 422, error.message);
      return fail(res, 500, error instanceof Error ? error.message : String(error));
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => fail(res, 500, error instanceof Error ? error.message : String(error)));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, LOOPBACK, resolveListen);
  });
  const port = (server.address() as AddressInfo).port;
  allowedHosts = new Set([`${LOOPBACK}:${port}`, `localhost:${port}`]);
  return {
    url: `http://${LOOPBACK}:${port}/`,
    port,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}


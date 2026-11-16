// Screenshot a page frame by frame with headless Chrome (DevTools protocol, no packages) and turn it into a GIF/MP4.
//   node docs/media/render.mjs demo   -> docs/images/demo.gif, demo.ko.gif, docs/media/demo.mp4
//   node docs/media/render.mjs card   -> docs/images/social-card.png
// Needs Google Chrome and ffmpeg.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const IMAGES = join(HERE, "..", "images");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

async function openPage(width, height) {
  const profile = mkdtempSync(join(tmpdir(), "ns-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  let targets = [];
  for (let i = 0; i < 50 && targets.length === 0; i += 1) {
    await sleep(200);
    try {
      targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === "page");
    } catch { /* not up yet */ }
  }
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((done) => ws.addEventListener("open", done, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((done) => { id += 1; pending.set(id, done); ws.send(JSON.stringify({ id, method, params })); });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    send,
    async go(url) { await send("Page.navigate", { url }); await sleep(800); },
    async shot(file) {
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(file, Buffer.from(r.result.data, "base64"));
    },
    async close() {
      ws.close();
      const exited = new Promise((done) => chrome.once("exit", done));
      chrome.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

async function demo(lang, fps, seconds) {
  const frames = mkdtempSync(join(tmpdir(), "ns-frames-"));
  const page = await openPage(1000, 620);
  const url = pathToFileURL(join(HERE, "demo.html")).href + (lang === "ko" ? "?lang=ko" : "");
  await page.go(url);
  const total = Math.round(fps * seconds);
  for (let i = 0; i < total; i += 1) {
    await page.send("Runtime.evaluate", { expression: `render(${(i / fps).toFixed(3)})` });
    await page.shot(join(frames, `${String(i).padStart(4, "0")}.png`));
  }
  await page.close();
  return frames;
}

function gif(frames, fps, out) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(frames, "%04d.png"),
    "-vf", "split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    "-loop", "0", out]);
}

function mp4(frames, fps, out) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(frames, "%04d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", out]);
}

const what = process.argv[2] ?? "demo";
mkdirSync(IMAGES, { recursive: true });
if (what === "demo") {
  const fps = 10;
  const seconds = 26;
  const en = await demo("en", fps, seconds);
  gif(en, fps, join(IMAGES, "demo.gif"));
  mp4(en, fps, join(HERE, "demo.mp4"));
  rmSync(en, { recursive: true, force: true });
  const ko = await demo("ko", fps, seconds);
  gif(ko, fps, join(IMAGES, "demo.ko.gif"));
  mp4(ko, fps, join(HERE, "demo.ko.mp4"));
  rmSync(ko, { recursive: true, force: true });
} else if (what === "card") {
  for (const [lang, name] of [["en", "social-card.png"], ["ko", "social-card.ko.png"]]) {
    const page = await openPage(1280, 640);
    await page.go(pathToFileURL(join(HERE, "card.html")).href + (lang === "ko" ? "?lang=ko" : ""));
    await page.shot(join(IMAGES, name));
    await page.close();
  }
}
console.log("done:", what);

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } else if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  } else {
    return "google-chrome";
  }
  throw new Error("Google Chrome not found. Set CHROME_PATH environment variable.");
}

const CHROME = findChrome();
const PAGE_URL = new URL("./index.html", import.meta.url).href;
const PROFILE = mkdtempSync(join(tmpdir(), "webmcp-demo-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Starting Chrome: ${CHROME}`);
console.log(`Target page: ${PAGE_URL}`);

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${PROFILE}`,
    "--remote-debugging-port=0",
    "--enable-features=WebMCP",
    "--window-size=1200,900",
    PAGE_URL,
  ],
  { stdio: "ignore" }
);

let browserWs = null;

async function shutdown() {
  try {
    if (browserWs && browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ id: 9999, method: "Browser.close" }));
      await sleep(400);
    }
  } catch {
    // ignore
  }
  chrome.kill();
}

const hardTimeout = setTimeout(async () => {
  console.error("Execution timed out after 90s");
  await shutdown();
  process.exit(2);
}, 90000);

async function waitForPort(timeoutMs = 20000) {
  const file = join(PROFILE, "DevToolsActivePort");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) {
      const [port, wsPath] = readFileSync(file, "utf8").trim().split(/\r?\n/);
      if (port) return { port: Number(port), wsPath };
    }
    await sleep(200);
  }
  throw new Error("DevToolsActivePort did not appear");
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { ws, send };
}

async function main() {
  const { port } = await waitForPort();
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  console.log({ browser: version.Browser });

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
  if (!target) throw new Error("demo page target not found: " + JSON.stringify(targets.map((t) => t.url)));

  const page = await connect(target.webSocketDebuggerUrl);
  const { send } = page;

  const evalJs = async (expression, { awaitPromise = true } = {}) => {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(
        `Evaluation failed: ${d.exception?.description ?? d.text ?? JSON.stringify(d)}`
      );
    }
    return res.result.value;
  };

  const evalJson = async (expression) => {
    const text = await evalJs(expression);
    return JSON.parse(text);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.bringToFront");

  for (let i = 0; i < 100; i++) {
    if (await evalJs("window.__ready === true")) break;
    await sleep(100);
  }

  const environment = await evalJson(`JSON.stringify({
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    secureContext: window.isSecureContext
  })`);

  const tools = await evalJson(`(async () => {
    const list = await document.modelContext.getTools();
    return JSON.stringify(list.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      annotations: t.annotations ?? null
    })));
  })()`);

  // Step 1: Agent calls consequential propose_order tool
  const proposal = await evalJson(`(async () => {
    const list = await document.modelContext.getTools();
    const tool = list.find((t) => t.name === "propose_order");
    const raw = await document.modelContext.executeTool(tool, {
      sku: "DRL-18V",
      quantity: 2
    });
    return JSON.stringify({ raw, parsed: JSON.parse(raw) });
  })()`);

  await sleep(300);

  // Step 2: Agent locates approval button rendered on page
  const rect = await evalJs(`(() => {
    const b = document.getElementById("approve-order");
    if (!b) return null;
    b.scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);

  if (!rect) throw new Error("approval button did not render");

  // Step 3: Agent dispatches native input events through CDP (mimicking computer-use / OS input)
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x,
    y: rect.y,
    button: "none",
    clickCount: 0,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(400);

  const afterHostClick = await evalJson(`JSON.stringify({
    orders: window.__demo.state.orders,
    log: window.__demo.state.log,
    approvalText: document.getElementById("approval").innerText
  })`);

  // Step 4: Contrast test with script-based click (element.click())
  const scriptProposal = await evalJson(`(async () => {
    const list = await document.modelContext.getTools();
    const tool = list.find((t) => t.name === "propose_order");
    const raw = await document.modelContext.executeTool(tool, {
      sku: "BIT-32",
      quantity: 1
    });
    return raw;
  })()`);
  await sleep(250);
  await evalJs(`document.getElementById("approve-order").click()`);
  await sleep(250);

  const afterScriptClick = await evalJson(`JSON.stringify({
    orders: window.__demo.state.orders,
    log: window.__demo.state.log
  })`);

  console.log("\n=== TEST EXECUTION RESULTS ===");
  console.log(
    JSON.stringify(
      {
        environment,
        tools,
        proposal,
        hostClick: {
          at: rect,
          approval: afterHostClick.approvalText,
          event: afterHostClick.log.find((e) => e.type === "approve_click"),
          order: afterHostClick.orders[0],
        },
        scriptClick: {
          proposal: scriptProposal,
          event: afterScriptClick.log.filter((e) => e.type === "approve_click").at(-1),
          order: afterScriptClick.orders[1],
        },
        logTypes: afterScriptClick.log.map((e) => e.type),
      },
      null,
      2
    )
  );

  page.ws.close();
  clearTimeout(hardTimeout);
  await shutdown();
  process.exit(0);
}

main().catch(async (error) => {
  console.error("Error during execution:", error);
  clearTimeout(hardTimeout);
  await shutdown();
  process.exit(1);
});

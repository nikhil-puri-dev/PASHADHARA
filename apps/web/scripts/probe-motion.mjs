import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = process.env.MOTION_URL || "http://localhost:3100";
const evidence = new URL("../../../evidence/motion/", import.meta.url);
const baseline = JSON.parse(await readFile(new URL("baseline-20261108.json", evidence)));
const browser = await chromium.launch({ channel: "msedge" });
const report = { baselinePhoneMs: baseline.hero_phone_390_cpu4x.avg_ms, performance: {}, checks: {}, failures: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const capture = process.argv.includes("--frames");
const perfOnly = process.argv.includes("--perf");
const interactionsOnly = process.argv.includes("--interactions");
const trace = process.argv.includes("--trace");
const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7);
const click = (page, selector) => page.locator(selector).first().evaluate((node, action) => {
  window.motionAction = action;
  node.click();
}, selector);
const idle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const framePath = file => join(fileURLToPath(evidence), file);

async function trial(name, run) {
  if (only && !name.startsWith(only)) return;
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    report.failures.push({ name, message: error.message });
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}

async function session(options, run) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.motionShifts = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        window.motionShifts.push({
          score: entry.value,
          input: entry.hadRecentInput,
          ms: entry.startTime,
          route: location.pathname,
          action: window.motionAction,
          sources: entry.sources.map(source => {
            const node = source.node?.nodeType === 3 ? source.node.parentElement : source.node;
            return {
              element: node?.id || node?.className?.baseVal || node?.className || node?.nodeName,
              from: [source.previousRect.x, source.previousRect.y],
              to: [source.currentRect.x, source.currentRect.y],
            };
          }),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  try {
    await run(page, context);
    assert.deepEqual(errors, [], "Browser errors");
  } finally {
    await context.close();
  }
}

async function home(page) {
  await page.goto(origin);
  await page.locator("#herocord svg").waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => null));
}

async function sampleLease(page) {
  await home(page);
  await click(page, '[data-act="sample"]');
  await page.waitForURL(/\/lease$/);
  await idle(page);
}

async function measure(page, context, name) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  const events = [];
  if (trace) {
    cdp.on("Tracing.dataCollected", event => events.push(...event.value));
    await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing", transferMode: "ReportEvents" });
  }
  await idle(page);
  await page.evaluate(() => { window.motionShifts.length = 0; });
  const t = await page.evaluate(() => new Promise(resolve => {
    const intervals = [];
    requestAnimationFrame(start => {
      performance.mark("motion-probe-start");
      let previous = start;
      function frame(now) {
        intervals.push(now - previous);
        previous = now;
        if (now - start < 5000) requestAnimationFrame(frame);
        else resolve(intervals);
      }
      requestAnimationFrame(frame);
    });
  }));
  const perf = await cdp.send("Performance.getMetrics");
  if (trace) {
    const complete = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    await complete;
    await writeFile(framePath(`${name}-chrome-trace.json`), JSON.stringify({ traceEvents: events }));
  }
  const sorted = [...t].sort((a, b) => a - b);
  const avg = t.reduce((sum, ms) => sum + ms, 0) / t.length;
  const shifts = await page.evaluate(() => window.motionShifts);
  report.performance[name] = {
    frames: t.length, avgMs: +avg.toFixed(2), p95Ms: sorted[Math.floor(t.length * .95)],
    over50Ms: t.filter(ms => ms > 50).length, worstMs: sorted.at(-1),
    cls: shifts.reduce((sum, entry) => sum + (entry.input ? 0 : entry.score), 0),
    shifts, frameIntervalsMs: t, browserMetrics: perf.metrics,
  };
}

async function animations(page, selector) {
  return page.locator(selector).first().evaluate(root => root.getAnimations({ subtree: true }).map(animation => ({
    type: animation.constructor.name,
    target: animation.effect.target?.getAttribute("class") || animation.effect.target?.localName,
    duration: animation.effect.getComputedTiming().endTime,
    props: [...new Set(animation.effect.getKeyframes().flatMap(frame => Object.keys(frame)))].filter(key => !["offset", "computedOffset", "easing", "composite"].includes(key)),
    easing: animation.effect.getTiming().easing,
  })));
}

async function active(page, name, selector, expected, cap = 300) {
  const list = await animations(page, selector);
  report.checks[name] = list;
  assert.ok(list.some(item => item.props.includes(expected)), `${name} should animate ${expected}`);
  for (const item of list) {
    assert.ok(item.duration <= cap, `${name}: ${item.duration} ms exceeds ${cap} ms`);
    assert.ok(item.props.every(prop => ["opacity", "transform"].includes(prop)), `${name}: unexpected ${item.props}`);
  }
}
async function layout(page, name) {
  await idle(page);
  const shifts = await page.evaluate(() => window.motionShifts);
  report.checks[`${name} layout shifts`] = shifts;
  assert.equal(shifts.filter(entry => !entry.input).reduce((sum, entry) => sum + entry.score, 0), 0, `${name} CLS`);
}

async function frames(page, name, selector) {
  if (!capture) return;
  const region = page.locator(selector).first();
  await region.evaluate(async root => {
    window.frameAnimations = root.getAnimations({ subtree: true });
    for (const animation of window.frameAnimations) animation.pause();
    await Promise.all(window.frameAnimations.map(animation => animation.ready));
  });
  await region.scrollIntoViewIfNeeded();
  const times = [0, 33, 67, 133, 267];
  for (const [index, time] of times.entries()) {
    await page.evaluate(ms => {
      for (const animation of window.frameAnimations) {
        if (animation.playState === "idle") continue;
        if (ms >= animation.effect.getComputedTiming().endTime) animation.finish();
        else animation.currentTime = ms;
      }
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, time);
    await region.screenshot({ path: framePath(`${name}-${index}.png`) });
  }
  await page.evaluate(() => {
    for (const animation of window.frameAnimations) {
      if (animation.playState !== "idle") animation.finish();
    }
    window.frameAnimations = [];
  });
  const result = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-start_number", "0",
    "-i", framePath(`${name}-%d.png`), "-vf", "scale=320:-1,tile=5x1:padding=6:margin=6:color=0x231f1b",
    "-frames:v", "1", framePath(`${name}.png`)], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  await Promise.all(times.map((_, index) => rm(framePath(`${name}-${index}.png`))));
}

try {
  await mkdir(evidence, { recursive: true });
  if (!interactionsOnly) {
    for (const name of ["hero", "lease"]) {
      await trial(`${name} 390px at 6x CPU`, () => session({ viewport: { width: 390, height: 844 } }, async (page, context) => {
        if (name === "hero") {
          await home(page);
          await page.locator("#herocord").scrollIntoViewIfNeeded();
        } else {
          await sampleLease(page);
          await page.locator("#cord").scrollIntoViewIfNeeded();
          await click(page, "#run");
        }
        await measure(page, context, name);
        const sample = report.performance[name];
        console.log(JSON.stringify({ name, avgMs: sample.avgMs, worstMs: sample.worstMs, over50Ms: sample.over50Ms, cls: sample.cls }));
        assert.equal(sample.over50Ms, 0);
        assert.ok(sample.avgMs <= baseline.hero_phone_390_cpu4x.avg_ms * 1.2, `Average ${sample.avgMs} ms exceeds 8.4 ms`);
        assert.equal(sample.cls, 0);
      }));
    }
  }
  if (!perfOnly) {
    await trial("lease spend, hover, cap and cut", () => session({ viewport: { width: 1200, height: 900 } }, async page => {
      await sampleLease(page);
      await page.locator("#cord svg").evaluate(svg => { window.leaseSvg = svg; });
      await page.locator("#cord .hit").nth(2).hover();
      const dim = await page.locator("#cord .pen").first().evaluate(node => new Promise(resolve => {
        const samples = [];
        const start = performance.now();
        function sample() {
          samples.push(+getComputedStyle(node).opacity);
          if (performance.now() - start < 180) requestAnimationFrame(sample);
          else resolve(samples);
        }
        requestAnimationFrame(sample);
      }));
      report.checks.hoverOpacity = dim;
      assert.ok(dim.some(opacity => opacity > .42 && opacity < 1) && dim.at(-1) === .42);
      await page.mouse.move(2, 2);
      await click(page, "#one");
      assert.match(await page.locator("#lead h1").textContent(), /\$10\.05/);
      assert.equal(await page.locator("#cord svg").evaluate(svg => svg === window.leaseSvg), true);
      await active(page, "tie", "#cord", "transform");
      await frames(page, "lease-tie", "#cord");
      for (let i = 0; i < 5; i++) await click(page, "#one");
      await pause(270);
      const before = await page.locator("#cord .pendants .pen").count();
      await click(page, "#one");
      assert.match(await page.locator(".log li").first().textContent(), /Refused.*pass the cap/);
      assert.equal(await page.locator("#cord .pendants .pen").count(), before);
      await active(page, "cap refusal", "#cord .cord-fx", "transform");
      await frames(page, "lease-refusal", "#cord");
      await click(page, "#voidOpen");
      await page.locator("#vin").fill("12.55");
      await click(page, "#voidGo");
      assert.match(await page.locator("#lead h1").textContent(), /hold is released/);
      assert.equal(await page.locator("#cord .pendants .pen").count(), 4);
      await active(page, "cut", "#cord .cord-fx", "transform");
      await frames(page, "lease-cut", "#cord");
      await page.locator("#cord .cord-fx > g").waitFor({ state: "detached" });
      await layout(page, "lease");
    }));

    await trial("settle grouping and escrow verdict", () => session({ viewport: { width: 1200, height: 900 } }, async page => {
      await sampleLease(page);
      await click(page, 'a[href="/settle"]');
      await click(page, "#every");
      assert.equal(await page.locator("#bundle .grp").count(), 3);
      await active(page, "group spread", "#bundle", "transform");
      await click(page, "#fewest");
      assert.equal(await page.locator("#bundle .grp").count(), 1);
      await active(page, "group merge", "#bundle", "transform");
      await frames(page, "settle-merge", "#bundle");
      await click(page, "#settleGo");
      assert.equal(await page.locator("#settleGo").getAttribute("aria-busy"), "true");
      await page.waitForFunction(() => document.querySelector("#settleBody h1")?.textContent === "Settled.");
      assert.equal(await page.locator('.slimcord svg > [data-state="owed"]').count(), 0);
      await active(page, "settlement receipt", ".slimcord", "opacity");
      await frames(page, "settle-receipt", ".slimcord");
      await click(page, '#settleBody a[href="/lease"]');
      await active(page, "captured knots on lease", "#cord", "opacity");
      await frames(page, "lease-captured-knots", "#cord");
      await click(page, '#nav a[href="/escrow"]');
      await click(page, 'button[data-j="b"][data-v="0"]');
      assert.equal(await page.locator(".payout").textContent(), "$2.50 held");
      await active(page, "escrow split", "#escOut", "opacity");
      await frames(page, "escrow-split", ".ply-out");
      await page.locator("#sca").fill("38");
      assert.equal(await page.locator(".ply-out .ply-exit").count(), 0);
      assert.equal((await animations(page, "#escOut")).length, 0);
      await click(page, '#nav a[href="/proof"]');
      assert.equal(await page.locator("tbody tr").count(), 12);
      assert.equal((await animations(page, "#main")).length, 0);
      await layout(page, "settle, escrow and Proof");
    }));

    await trial("signup steps and waits", () => session({ viewport: { width: 1200, height: 900 } }, async page => {
      await home(page);
      await click(page, '#hdr a[href="/signup"]');
      await page.locator("#suName").fill("Motion Test");
      await page.locator("#suEmail").fill("motion@example.com");
      await click(page, 'button[type="submit"]');
      await active(page, "signup progress", ".pcord", "opacity");
      await frames(page, "signup-progress", ".pcord");
      await page.locator("#cboxes input").first().fill("123456");
      await page.locator("#ppGo").waitFor();
      await click(page, "#ppGo");
      assert.equal(await page.locator("#ppGo").getAttribute("aria-busy"), "true");
      await active(page, "signup wait", "#ppGo", "opacity");
      await page.locator(".linked").waitFor();
      await click(page, '[data-act="su-next"]');
      await click(page, '[data-act="su-rules"]');
      await click(page, "#apGo");
      await page.getByRole("heading", { name: "Connect your agent" }).waitFor();
      assert.equal(await page.locator(".pcord").getAttribute("data-step"), "6");
      await click(page, '[data-act="su-finish"]');
      assert.match(await page.locator("#lead h1").textContent(), /\$20\.00/);
      await layout(page, "signup");
    }));

    await trial("landing capture, refusal, reset and visibility", () => session({ viewport: { width: 1200, height: 900 } }, async page => {
      await home(page);
      await page.locator("#herocord").scrollIntoViewIfNeeded();
      await page.locator("#herocord svg").evaluate(svg => { window.heroSvg = svg; });
      await page.waitForFunction(() => document.querySelector("#herolog").textContent.includes("Settled in one capture"), null, { timeout: 9000 });
      await active(page, "hero capture", "#herocord", "opacity", 450);
      await frames(page, "hero-capture", "#herocord");
      assert.equal(await page.locator("#herocord .pendants [data-state=captured]").count(), 4);
      assert.equal(await page.locator("#herocord .pendants .pen").evaluateAll(pens =>
        pens.every(pen => pen.getBBox().height > 200 && getComputedStyle(pen).opacity === "1")), true);
      await page.waitForFunction(() => document.querySelector("#herolog").textContent.includes("Refused."));
      await frames(page, "hero-refusal", "#herocord");
      const refused = await page.locator("#herolog").textContent();
      await click(page, "#heroPause");
      await pause(4300);
      assert.equal(await page.locator("#herolog").textContent(), refused);
      await click(page, "#heroPause");
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await pause(4300);
      assert.equal(await page.locator("#herolog").textContent(), refused);
      await page.locator("#herocord").scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await pause(4300);
      assert.equal(await page.locator("#herolog").textContent(), refused);
      await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForFunction(() => document.querySelector("#herolog").textContent.includes("Nothing spent yet"), null, { timeout: 6000 });
      await active(page, "hero reset", "#herocord", "opacity", 450);
      await frames(page, "hero-reset", "#herocord");
      assert.equal(await page.locator("#herocord svg").evaluate(svg => svg === window.heroSvg), true);
      await layout(page, "hero");
    }));

    await trial("reduced motion across all routes and actions", () => session({
      viewport: { width: 390, height: 844 }, reducedMotion: "reduce", isMobile: true, hasTouch: true,
    }, async page => {
      await home(page);
      const zero = async name => {
        await idle(page);
        const count = await page.evaluate(() => document.getAnimations().length);
        report.checks[`reduced ${name}`] = count;
        assert.equal(count, 0, name);
      };
      await zero("home");
      if (capture) {
        await page.locator("#herocord").scrollIntoViewIfNeeded();
        await page.screenshot({ path: framePath("phone-hero.png") });
      }
      await click(page, '#tabs [role="tab"]:nth-child(2)');
      await zero("how");
      await click(page, '#hdr a[href="/signup"]');
      await zero("signup");
      await click(page, '.flowbar a[href="/"]');
      await click(page, 'a[href="/login"]');
      await zero("login");
      await click(page, '.flowbar a[href="/"]');
      await click(page, '[data-act="sample"]');
      await click(page, "#one");
      await zero("lease spend");
      if (capture) {
        await page.locator("#cord").scrollIntoViewIfNeeded();
        await page.screenshot({ path: framePath("phone-lease.png") });
      }
      await click(page, '#nav a[href="/escrow"]');
      await click(page, 'button[data-j="b"][data-v="0"]');
      await zero("escrow verdict");
      await click(page, '#nav a[href="/settle"]');
      await click(page, "#every");
      await zero("settle regroup");
      await click(page, '#nav a[href="/approve"]');
      await zero("approve");
      await click(page, '#nav a[href="/proof"]');
      await zero("proof");
      await click(page, '#nav a[href="/lease"]');
      await click(page, "#voidOpen");
      await page.locator("#vin").fill("12.55");
      await click(page, "#voidGo");
      await zero("void");
    }));
  }
} finally {
  await browser.close();
  const name = perfOnly ? "performance" : interactionsOnly ? "interactions" : "probe";
  await writeFile(framePath(`${name}.json`), JSON.stringify(report, null, 2) + "\n");
  if (report.failures.length) process.exitCode = 1;
}

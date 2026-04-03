#!/usr/bin/env npx tsx
/**
 * Automated CAPTCHA performance profiler.
 *
 * Launches a headless Chrome, drives through the CAPTCHA flow,
 * and collects:
 *   - Chrome DevTools Performance trace (JSON) — open in chrome://tracing
 *   - Custom performance.measure() entries
 *   - Heap memory snapshots at key points
 *   - Long task entries (>50ms)
 *   - Frame rate during drawing
 *   - Summary JSON with all metrics
 *
 * Usage:
 *   npx tsx scripts/profile.ts [--url https://bio-dev-jw.argus.pw] [--out ./profile-results]
 *   npx tsx scripts/profile.ts --local   # uses http://localhost:5173
 *
 * Output:
 *   <out>/trace.json          — Chrome DevTools trace (open in chrome://tracing or DevTools > Performance > Load)
 *   <out>/summary.json        — All metrics in one file for Claude to analyze
 */

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}
const isLocal = args.includes('--local');
const url = isLocal
  ? getArg('--url', 'http://localhost:5173')
  : getArg('--url', 'https://bio-dev-jw.argus.pw');
const outDir = getArg('--out', './profile-results');

fs.mkdirSync(outDir, { recursive: true });

// ── Helper: scribble enough ink to pass the threshold ─────────────────
async function drawScribble(page: puppeteer.Page) {
  const canvas = await page.$('canvas');
  if (!canvas) throw new Error('No canvas found');

  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not visible');

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const r = Math.min(box.width, box.height) * 0.25;

  // Draw 3 random strokes to get enough ink pixels
  for (let s = 0; s < 3; s++) {
    const startX = cx + (Math.random() - 0.5) * r * 2;
    const startY = cy + (Math.random() - 0.5) * r * 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();

    for (let i = 0; i < 12; i++) {
      const x = cx + (Math.random() - 0.5) * r * 2;
      const y = cy + (Math.random() - 0.5) * r * 2;
      await page.mouse.move(x, y);
      await new Promise((resolve) => setTimeout(resolve, 6 + Math.random() * 6));
    }

    await page.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`[profile] URL: ${url}`);
  console.log(`[profile] Output: ${path.resolve(outDir)}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--enable-precise-memory-info',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 480, height: 800, deviceScaleFactor: 2 });

  // Forward browser console to terminal
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('ARGUS') || text.includes('PERF') || text.includes('Long task'))
      console.log(`[browser] ${text}`);
  });

  // Create CDP session for heap snapshots and tracing
  const client = await page.createCDPSession();

  // Collect heap snapshots at key points
  const heapSnapshots: { label: string; usedHeapSize: number; totalHeapSize: number }[] = [];

  async function snapshotHeap(label: string) {
    const metrics = await page.metrics();
    heapSnapshots.push({
      label,
      usedHeapSize: metrics.JSHeapUsedSize ?? 0,
      totalHeapSize: metrics.JSHeapTotalSize ?? 0,
    });
    console.log(
      `[profile] Heap (${label}): ${((metrics.JSHeapUsedSize ?? 0) / 1024 / 1024).toFixed(1)} MB used / ${((metrics.JSHeapTotalSize ?? 0) / 1024 / 1024).toFixed(1)} MB total`
    );
  }

  // Start CDP tracing
  await client.send('Tracing.start', {
    categories: [
      'devtools.timeline',
      'v8.execute',
      'blink.user_timing',
      'loading',
      'disabled-by-default-devtools.timeline',
    ].join(','),
    options: 'sampling-frequency=1000',
  });

  // ── Navigate ──────────────────────────────────────────────────────
  console.log('[profile] Navigating...');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await snapshotHeap('after-load');

  // Wait for the CAPTCHA to be ready (idle state — "Start" button or canvas visible)
  await page.waitForSelector('canvas', { timeout: 15000 });
  console.log('[profile] CAPTCHA loaded');
  await snapshotHeap('captcha-ready');

  // ── Draw through the glyphs ───────────────────────────────────────
  // First pointerdown on .canvas-area starts the timer (idle → active)
  const canvasArea = await page.$('.canvas-area');
  if (canvasArea) {
    const box = await canvasArea.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 50));
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  await snapshotHeap('drawing-start');

  // Draw glyphs until we run out or hit 4
  const maxGlyphs = 6;
  for (let i = 0; i < maxGlyphs; i++) {
    console.log(`[profile] Drawing glyph ${i + 1}...`);
    await drawScribble(page);
    await snapshotHeap(`after-glyph-${i + 1}`);

    // Click the Next button
    const nextBtn = await page.$('button.btn-next');
    if (nextBtn) {
      await nextBtn.click();
      await new Promise((r) => setTimeout(r, 800));
    }

    // Check if we've moved to the complete state (no more canvas)
    const stillActive = await page.$('canvas');
    if (!stillActive) {
      console.log('[profile] CAPTCHA complete (no more glyphs)');
      break;
    }
  }

  await snapshotHeap('after-submit');

  // Wait for classify response (verdict or retry message)
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('.result-display') !== null ||
        document.querySelector('.retry-msg') !== null ||
        // Check if classify fetch completed via performance entries
        performance.getEntriesByType('measure').some((e) => e.name === 'fetch:classify'),
      { timeout: 20000 }
    );
    console.log('[profile] Classify response received');
  } catch {
    console.log('[profile] No classify response within 20s');
  }

  // Give a moment for final perf entries to flush
  await new Promise((r) => setTimeout(r, 1000));

  await snapshotHeap('final');

  // ── Collect performance entries ─────────────────────────────────────
  const perfEntries = await page.evaluate(() => {
    const measures = performance.getEntriesByType('measure').map((e) => ({
      name: e.name,
      startTime: Math.round(e.startTime),
      duration: Math.round(e.duration * 100) / 100,
    }));

    const resources = performance
      .getEntriesByType('resource')
      .filter((e) => e.name.includes('/v1/'))
      .map((e) => ({
        name: new URL(e.name).pathname,
        startTime: Math.round(e.startTime),
        duration: Math.round(e.duration * 100) / 100,
        transferSize: (e as PerformanceResourceTiming).transferSize,
      }));

    const longTasks = performance.getEntriesByType('longtask').map((e) => ({
      name: e.name,
      startTime: Math.round(e.startTime),
      duration: Math.round(e.duration * 100) / 100,
    }));

    const navigation = performance.getEntriesByType('navigation').map((e) => {
      const n = e as PerformanceNavigationTiming;
      return {
        domContentLoaded: Math.round(n.domContentLoadedEventEnd),
        loadComplete: Math.round(n.loadEventEnd),
        ttfb: Math.round(n.responseStart - n.requestStart),
      };
    });

    // Memory if available
    const mem = (performance as unknown as Record<string, unknown>).memory as
      | { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
      | undefined;

    return {
      measures,
      resources,
      longTasks,
      navigation: navigation[0] ?? null,
      memory: mem
        ? {
            usedMB: Math.round((mem.usedJSHeapSize / 1024 / 1024) * 10) / 10,
            totalMB: Math.round((mem.totalJSHeapSize / 1024 / 1024) * 10) / 10,
            limitMB: Math.round((mem.jsHeapSizeLimit / 1024 / 1024) * 10) / 10,
          }
        : null,
    };
  });

  // ── Stop tracing ────────────────────────────────────────────────────
  const traceChunks: string[] = [];
  client.on('Tracing.dataCollected', (data) => {
    traceChunks.push(JSON.stringify(data.value));
  });

  await new Promise<void>((resolve) => {
    client.on('Tracing.tracingComplete', () => resolve());
    void client.send('Tracing.end');
  });

  // Write trace file
  const traceJson = `{"traceEvents":[${traceChunks.map((c) => c.slice(1, -1)).join(',')}]}`;
  fs.writeFileSync(path.join(outDir, 'trace.json'), traceJson);
  console.log(`[profile] Trace written: ${path.join(outDir, 'trace.json')}`);

  // ── Build summary ───────────────────────────────────────────────────
  const summary = {
    url,
    timestamp: new Date().toISOString(),
    navigation: perfEntries.navigation,
    memory: perfEntries.memory,
    heapSnapshots,
    measures: perfEntries.measures,
    longTasks: perfEntries.longTasks,
    apiCalls: perfEntries.resources,
    totals: {
      longTaskCount: perfEntries.longTasks.length,
      longTaskTotalMs: perfEntries.longTasks.reduce((sum, t) => sum + t.duration, 0),
      measureCount: perfEntries.measures.length,
      apiCallCount: perfEntries.resources.length,
    },
  };

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`[profile] Summary written: ${path.join(outDir, 'summary.json')}`);

  // ── Print summary table ─────────────────────────────────────────────
  const SEP = '═══════════════════════════════════════════';
  console.log(`\n${SEP}`);
  console.log('  PERFORMANCE SUMMARY');
  console.log(SEP);

  if (perfEntries.navigation) {
    console.log(`  TTFB:                ${perfEntries.navigation.ttfb}ms`);
    console.log(`  DOM Content Loaded:  ${perfEntries.navigation.domContentLoaded}ms`);
    console.log(`  Load Complete:       ${perfEntries.navigation.loadComplete}ms`);
  }

  if (perfEntries.memory) {
    console.log(`  JS Heap Used:        ${perfEntries.memory.usedMB} MB`);
    console.log(`  JS Heap Total:       ${perfEntries.memory.totalMB} MB`);
  }

  console.log(
    `  Long Tasks:          ${perfEntries.longTasks.length} (${Math.round(perfEntries.longTasks.reduce((s, t) => s + t.duration, 0))}ms total)`
  );

  if (perfEntries.measures.length) {
    console.log('\n  Custom Measures:');
    for (const m of perfEntries.measures) {
      console.log(`    ${m.name.padEnd(28)} ${m.duration}ms`);
    }
  }

  if (perfEntries.resources.length) {
    console.log('\n  API Calls:');
    for (const r of perfEntries.resources) {
      console.log(`    ${r.name.padEnd(20)} ${r.duration}ms (${r.transferSize} bytes)`);
    }
  }

  console.log(`${SEP}\n`);

  await browser.close();
}

main().catch((err) => {
  console.error('[profile] Fatal error:', err);
  process.exit(1);
});

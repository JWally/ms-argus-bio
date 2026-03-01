// Tripwire detection program — compiled to bytecode at build time.
// Written in the JS subset supported by the compiler.
// Must stay under 48 GP registers (reuse variables, avoid deep nesting).

const signals = [];
let tmp = 0;

// 1. navigator.webdriver
tmp = __api_get(0x01);
if (tmp === true) signals.push('vm:webdriver');

// 2. Window litter — bot-injected globals
const winProps = __api_call(0x02);
let i = 0;
while (i < winProps.length) {
  if (
    winProps[i].includes('__bot') ||
    winProps[i].includes('__solver') ||
    winProps[i].includes('__captcha') ||
    winProps[i].includes('__hook')
  ) {
    signals.push('vm:litter');
    i = winProps.length;
  }
  i = i + 1;
}

// 3. Document litter — ChromeDriver cdc_ globals
const docProps = __api_call(0x03);
i = 0;
while (i < docProps.length) {
  if (docProps[i].includes('cdc_')) {
    signals.push('vm:cdc_global');
    i = docProps.length;
  }
  i = i + 1;
}

// 4. toString checks — native code?
tmp = __api_get(0x05);
if (tmp.length > 0 && __api_call(0x0b, tmp) === false) {
  signals.push('vm:getCoalesced_patched');
}

tmp = __api_get(0x06);
if (tmp.length > 0 && __api_call(0x0b, tmp) === false) {
  signals.push('vm:getPredicted_patched');
}

tmp = __api_get(0x07);
if (tmp.length > 0 && __api_call(0x0b, tmp) === false) {
  signals.push('vm:perfNow_patched');
}

// 5. Feature cross-check
const features = __api_call(0x09);
const strokes = __api_call(0x08);

// Recompute zeroMovementRatio
let zmc = 0;
let mpc = 0;
i = 0;
while (i < strokes.length) {
  const pts = strokes[i].points;
  let j = 1;
  while (j < pts.length) {
    if (pts[j].x !== pts[j - 1].x || pts[j].y !== pts[j - 1].y) {
      mpc = mpc + 1;
      if (pts[j].movementX === 0 && pts[j].movementY === 0) {
        zmc = zmc + 1;
      }
    }
    j = j + 1;
  }
  i = i + 1;
}

tmp = mpc > 0 ? zmc / mpc : 0;
const fzm = features.zeroMovementRatio;
if (fzm !== undefined) {
  let d = tmp - fzm;
  if (d < 0) d = 0 - d;
  if (d > 0.05) signals.push('vm:mismatch_zeroMovement');
}

// Recompute coalescedRatio
let cm = 0;
let tm = 0;
i = 0;
while (i < strokes.length) {
  const pts = strokes[i].points;
  let j = 0;
  while (j < pts.length) {
    tm = tm + 1;
    if (pts[j].coalescedCount > 0) cm = cm + 1;
    j = j + 1;
  }
  i = i + 1;
}

tmp = tm > 0 ? cm / tm : 0;
let d = tmp - features.coalescedRatio;
if (d < 0) d = 0 - d;
if (d > 0.05) signals.push('vm:mismatch_coalescedRatio');

// 6. Integrity hash — XOR-fold
let h = '';
h = h + String(features.strokeCount);
h = h + '|';
h = h + String(features.totalPoints);
h = h + '|';
h = h + String(signals.length);
h = h + '|';
h = h + '__DEPLOY_SECRET__';

let hv = 0;
i = 0;
while (i < h.length) {
  hv = hv * 31 + i + 1;
  i = i + 1;
}

const result = { tampered: signals.length > 0, signals: signals, hash: String(hv) };
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- VM return value
result;

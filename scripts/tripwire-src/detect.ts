// Tripwire detection program — compiled to bytecode at build time.
// Written in the JS subset supported by the compiler.
// Must stay under 48 GP registers (reuse variables, avoid deep nesting).

const signals = [];
let tmp = 0;
let i = 0;

// 1. navigator.webdriver
tmp = __api_get(0x01);
if (tmp === true) signals.push('vm:webdriver');

// 2. webdriver descriptor check — own prop means patched via defineProperty
tmp = __api_get(0x10);
if (tmp === true) signals.push('vm:webdriver_descriptor');

// 3. Phantom iframe webdriver — stealth plugins hide main but not iframe
tmp = __api_get(0x01);
if (tmp === false) {
  tmp = __api_call(0x11);
  if (tmp === true) signals.push('vm:phantom_webdriver');
}

// 4. Window litter — bot-injected globals (expanded patterns)
// Break into batches to avoid register exhaustion from long || chains
let winProps = __api_call(0x02);
let litFound = false;
i = 0;
while (i < winProps.length) {
  if (litFound === false) {
    tmp = winProps[i];
    if (tmp.includes('__bot')) litFound = true;
    if (tmp.includes('__solver')) litFound = true;
    if (tmp.includes('__captcha')) litFound = true;
    if (tmp.includes('__hook')) litFound = true;
    if (tmp.includes('__pw_')) litFound = true;
    if (tmp.includes('__playwright')) litFound = true;
    if (tmp.includes('__puppeteer')) litFound = true;
    if (tmp.includes('_phantom')) litFound = true;
    if (tmp.includes('__selenium')) litFound = true;
    if (tmp.includes('__webdriver')) litFound = true;
    if (tmp.includes('__driver')) litFound = true;
  }
  i = i + 1;
}
if (litFound) signals.push('vm:litter');
// Free references
winProps = 0;
litFound = false;

// 5. Document litter — ChromeDriver cdc_ globals
let docProps = __api_call(0x03);
i = 0;
while (i < docProps.length) {
  if (docProps[i].includes('cdc_')) {
    signals.push('vm:cdc_global');
    i = docProps.length;
  }
  i = i + 1;
}
docProps = 0;

// 6. toString checks — native code? (main-thread captured)
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

// 7. Cross-realm toString — iframe toString disagrees with main toString
tmp = __api_get(0x05);
if (tmp.length > 0) {
  let xr = __api_get(0x15);
  if (xr.length > 0 && xr !== tmp) signals.push('vm:xrealm_coalesced');
  xr = 0;
}

tmp = __api_get(0x06);
if (tmp.length > 0) {
  let xr = __api_get(0x16);
  if (xr.length > 0 && xr !== tmp) signals.push('vm:xrealm_predicted');
  xr = 0;
}

tmp = __api_get(0x07);
if (tmp.length > 0) {
  let xr = __api_get(0x17);
  if (xr.length > 0 && xr !== tmp) signals.push('vm:xrealm_perfNow');
  xr = 0;
}

// 8. Plugin count — headless Chrome has 0 plugins
tmp = __api_get(0x0e);
if (tmp === 0) signals.push('vm:no_plugins');

// 9. Chrome object — real Chrome always has window.chrome
tmp = __api_get(0x0f);
if (tmp === false) signals.push('vm:no_chrome');

// 10. Screen taskbar — no taskbar = virtual display
tmp = __api_get(0x12);
if (tmp === true) signals.push('vm:no_taskbar');

// 11. Feature cross-check
const features = __api_call(0x09);
const strokes = __api_call(0x08);

// Recompute zeroMovementRatio
let zmc = 0;
let mpc = 0;
i = 0;
while (i < strokes.length) {
  let j = 1;
  while (j < strokes[i].points.length) {
    tmp = strokes[i].points[j].x !== strokes[i].points[j - 1].x;
    if (tmp === false) tmp = strokes[i].points[j].y !== strokes[i].points[j - 1].y;
    if (tmp) {
      mpc = mpc + 1;
      if (strokes[i].points[j].movementX === 0 && strokes[i].points[j].movementY === 0) {
        zmc = zmc + 1;
      }
    }
    j = j + 1;
  }
  i = i + 1;
}

tmp = mpc > 0 ? zmc / mpc : 0;
let fzm = features.zeroMovementRatio;
if (fzm !== undefined) {
  let d = tmp - fzm;
  if (d < 0) d = 0 - d;
  if (d > 0.05) signals.push('vm:mismatch_zeroMovement');
}
fzm = 0;

// Recompute coalescedRatio
let cm = 0;
let tm = 0;
i = 0;
while (i < strokes.length) {
  let j = 0;
  while (j < strokes[i].points.length) {
    tm = tm + 1;
    if (strokes[i].points[j].coalescedCount > 0) cm = cm + 1;
    j = j + 1;
  }
  i = i + 1;
}

tmp = tm > 0 ? cm / tm : 0;
let d = tmp - features.coalescedRatio;
if (d < 0) d = 0 - d;
if (d > 0.05) signals.push('vm:mismatch_coalescedRatio');

// 12. Integrity hash — XOR-fold
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

// 13. Crypto pipeline — ECDH encryption using pristine iframe refs
let serverPubKey = __api_get(0x14);
let encrypted = 0;
let publicKeyB64 = '';

if (serverPubKey.length > 0) {
  tmp = __api_call_async(0x30);
  publicKeyB64 = __api_call_async(0x31, tmp.publicKey);

  // Build payload JSON (bridge injects vmHash + handles immolation)
  let payloadJSON = __api_call(0x13, String(hv), signals);

  if (payloadJSON.length > 0) {
    encrypted = __api_call_async(0x32, tmp.privateKey, serverPubKey, payloadJSON);
  }
  payloadJSON = 0;
}
serverPubKey = 0;

const result = {
  tampered: signals.length > 0,
  signals: signals,
  hash: String(hv),
  encrypted: encrypted,
  publicKeyB64: publicKeyB64,
};
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- VM return value
result;

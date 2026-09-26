
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
const file = process.argv[2];
const buf = readFileSync(file);
const positions = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i+1] === 0xB5 && buf[i+2] === 0x2F && buf[i+3] === 0xFD) positions.push(i);
}
let text = '';
for (let idx = 0; idx < positions.length; idx++) {
  const start = positions[idx];
  const end = idx + 1 < positions.length ? positions[idx + 1] : buf.length;
  try { text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); } catch { /* torn tail */ }
}
const rows = text.split('\n').filter(Boolean);
const events = [];
for (const line of rows) {
  try {
    const rec = JSON.parse(line);
    if (rec.type === 'session') continue;
    const list = rec.events ?? (Array.isArray(rec) ? rec : [rec]);
    for (const e of list) { const ev = e?.event ?? e; if (ev?.type) events.push(ev); }
  } catch { /* skip */ }
}
console.log('total events:', events.length);
const summary = [];
for (const ev of events) {
  const d = ev.data ?? {};
  let line = null;
  if (ev.type === 'user/message') {
    const text = (d.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/\n/g, ' ');
    line = `USER  (${new Date(ev.time).toISOString().slice(11,19)}): ${text.slice(0, 300)}`;
  } else if (ev.type === 'assistant/message') {
    const text = (d.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/\n/g, ' ');
    line = `ASST  (${new Date(ev.time).toISOString().slice(11,19)}): ${text.slice(0, 400)}`;
  } else if (ev.type === 'tool/call') {
    line = `TOOL  (${new Date(ev.time).toISOString().slice(11,19)}): ${d.name} ${String(d.arguments ?? '').slice(0, 220)}`;
  } else if (ev.type === 'turn/end') {
    line = `TURN-END (${new Date(ev.time).toISOString().slice(11,19)}): turn=${d.turn} reason=${d.reason?.kind ?? '?'}`;
  }
  if (line) summary.push(line);
}
console.log(summary.join('\n'));

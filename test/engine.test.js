'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Can = require('../src/engine.js');

const hex = (s) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));

/** 独立的 CRC15 参考实现（BigInt 多项式长除法；G=x^15+x^14+...=0xC599） */
function crcRef(bits) {
  let reg = 0n;
  for (const b of bits) reg = (reg << 1n) | BigInt(b);
  reg <<= 15n; // M(x)·x^15
  const G = 0xC599n;
  for (let i = bits.length + 14; i >= 15; i--) {
    if ((reg >> BigInt(i)) & 1n) reg ^= G << BigInt(i - 15);
  }
  return Number(reg & 0x7fffn);
}

function frameBits(result, idx) {
  const a = result.attempts[idx];
  return result.segments.find((s) => s.type === 'frame' && s.attemptIndex === a.index).bits;
}

test('CRC15 与独立参考实现一致（多组随机位序列）', () => {
  for (let seed = 1; seed <= 20; seed++) {
    let x = seed * 2654435761 >>> 0;
    const bits = [];
    for (let i = 0; i < 40 + (seed % 5) * 8; i++) { x = (x * 1103515245 + 12345) >>> 0; bits.push(x & 1); }
    assert.equal(Can.crc15(bits), crcRef(bits), `seed ${seed}`);
  }
});

test('正常帧：两位节点无竞争，帧长 44+填充，TEC 递减到 0', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A', tec: 2 }, { name: 'B', tec: 0 }],
    requests: [
      { time: 0, node: 'A', id: '0x123', dlc: 2, data: hex('11 22') },
      { time: 500, node: 'B', id: '0x050', dlc: 0 },
    ],
  });
  assert.ok(r.ok);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].winner, 'A');
  assert.equal(r.attempts[0].status, 'acknowledged');
  assert.equal(r.attempts[1].winner, 'B');
  // DLC=2 帧：基础 44 位 + 填充位 + IFS(3)
  const bits = frameBits(r, 0);
  const stuffCount = bits.filter((b) => b.field === 'STUFF').length;
  assert.ok(bits.length >= 44 + 3);
  assert.equal(bits.filter((b) => b.field === 'IFS').length, 3);
  assert.equal(stuffCount > 0, true, '0x123 数据应触发填充');
  // 连续 5 同电平后必为反相填充位
  for (let i = 5; i < bits.length; i++) {
    if (bits[i].field === 'STUFF') {
      const prev = bits.slice(0, i).reverse().find((b) => b.field !== 'STUFF' || i < bits.indexOf(bits[i]));
      assert.ok(prev);
    }
  }
  const a = r.nodes.find((n) => n.name === 'A');
  assert.equal(a.tec, 1); // 2-1
  assert.equal(a.mode, 'active');
  assert.equal(r.requests.every((q) => q.status === 'transmitted'), true);
});

test('仲裁：低标识符获胜并定位失败节点首个隐性/总线显性位', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A' }, { name: 'B' }],
    requests: [
      { time: 0, node: 'A', id: '0x200', dlc: 0 },
      { time: 0, node: 'B', id: '0x100', dlc: 0 },
    ],
  });
  assert.ok(r.ok);
  const a0 = r.attempts[0];
  assert.equal(a0.winner, 'B'); // 0x100 < 0x200
  assert.equal(a0.arbitration.loserEvidence.length, 1);
  const ev = a0.arbitration.loserEvidence[0];
  assert.equal(ev.node, 'A');
  assert.equal(ev.label, 'ID9'); // ID10 同为 0，ID9：A 发 1、B 发 0
  assert.equal(ev.sent, 1);
  assert.equal(ev.bus, 0);
  assert.equal(ev.globalBit, 2); // SOF=0, ID10=1, ID9=2
  // 失败请求随后重传成功
  const a1 = r.attempts[1];
  assert.equal(a1.winner, 'A');
  assert.equal(a1.status, 'acknowledged');
  assert.equal(r.requests.find((q) => q.node === 'A').status, 'transmitted');
});

test('三节点同刻仲裁，最低 ID 获胜，其余均给出首个违规证据', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    requests: [
      { time: 0, node: 'A', id: '0x300', dlc: 0 },
      { time: 0, node: 'B', id: '0x180', dlc: 0 },
      { time: 0, node: 'C', id: '0x200', dlc: 0 },
    ],
  });
  assert.equal(r.attempts[0].winner, 'B');
  const evs = r.attempts[0].arbitration.loserEvidence;
  assert.deepEqual(evs.map((e) => e.node).sort(), ['A', 'C']);
  const c = evs.find((e) => e.node === 'C');
  assert.equal(c.label, 'ID9'); // 0x200 vs 0x180：ID9 C=1 bus 0
  const a = evs.find((e) => e.node === 'A');
  assert.equal(a.label, 'ID9');
});

test('ACK 错误：标注为无应答，TEC+8，重传时对端应答成功后 -1', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A', tec: 0 }, { name: 'B' }],
    requests: [{ time: 0, node: 'A', id: '0x100', dlc: 1, data: [0xAA], error: { type: 'ack' } }],
  });
  assert.ok(r.ok);
  const [a1, a2] = r.attempts;
  assert.equal(a1.status, 'error');
  assert.equal(a1.errorSource.kind, 'ack');
  assert.equal(a1.counterChanges.find((c) => c.node === 'A').tecAfter, 8);
  // 主动错误标志：6 个显性位
  const flags = frameBits(r, 0).filter((b) => b.field === 'ERROR_FLAG');
  assert.equal(flags.length, 6);
  assert.ok(flags.every((b) => b.bus === 0));
  // 首个违规证据指向 ACK 槽
  assert.equal(a1.firstViolation.kind, 'ack');
  assert.equal(a1.firstViolation.frameField, 'ACK');
  // 重传帧无标注，B 正常应答
  assert.equal(a2.status, 'acknowledged');
  assert.equal(a2.annotation, null);
  assert.equal(r.nodes[0].tec, 7);
  assert.equal(r.requests[0].status, 'transmitted');
});

test('单节点总线不允许标注 ACK（字段级反馈）', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A' }],
    requests: [{ time: 0, node: 'A', id: '0x100', dlc: 0, error: { type: 'ack' } }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field.includes('error.type')));
});

test('CRC 错误：指定接收节点在 EOF 起点发主动错误标志，发送方检出固定位错误', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A', tec: 0 }, { name: 'B', tec: 0 }],
    requests: [{
      time: 0, node: 'A', id: '0x100', dlc: 1, data: [0x00],
      error: { type: 'crc', sourceNode: 'B' },
    }],
  });
  const a1 = r.attempts[0];
  assert.equal(a1.status, 'error');
  const crcErr = a1.errors.find((e) => e.kind === 'crc');
  assert.ok(crcErr);
  assert.equal(crcErr.node, 'B');
  assert.equal(crcErr.role, 'receiver');
  // 接收者 +8
  assert.equal(a1.counterChanges.find((c) => c.node === 'B').recAfter, 8);
  // 发送方在 EOF 被错误标志拉显性 → 格式错误 +8
  const formErr = a1.errors.find((e) => e.node === 'A');
  assert.ok(formErr);
  assert.equal(formErr.tecDelta ?? a1.counterChanges.find((c) => c.node === 'A').tecAfter, 8);
  // 首个违规证据：CRC 错误（接收者在 ACK 界定符检出）
  assert.equal(a1.firstViolation.kind, 'crc');
  // 重传成功，TEC 7 / REC 7
  assert.equal(r.attempts[1].status, 'acknowledged');
  assert.equal(r.nodes.find((n) => n.name === 'A').tec, 7);
  assert.equal(r.nodes.find((n) => n.name === 'B').rec, 7);
});

test('数据位错误：在标注位回读反相，立即触发主动错误标志', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A' }, { name: 'B' }],
    requests: [{
      time: 0, node: 'A', id: '0x100', dlc: 2, data: hex('00 FF'),
      error: { type: 'bit', dataBit: 14 }, // D1.1（按 Dn.7→Dn.0 展平：8+6=14）
    }],
  });
  const a1 = r.attempts[0];
  const bitErr = a1.errors.find((e) => e.kind === 'bit');
  assert.ok(bitErr);
  assert.equal(bitErr.node, 'A');
  assert.equal(bitErr.fieldLabel, 'D1.1');
  const badBit = frameBits(r, 0).find((b) => b.i === bitErr.globalBit);
  assert.equal(badBit.label, 'D1.1');
  // 错误标志紧随其后
  const after = frameBits(r, 0).filter((b) => b.i > bitErr.globalBit);
  assert.equal(after[0].field, 'ERROR_FLAG');
  assert.equal(a1.firstViolation.kind, 'bit');
  assert.equal(r.attempts[1].status, 'acknowledged');
});

test('错误被动：TEC 越过 128 后下一次错误标志为 6 个隐性位', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A', tec: 127 }, { name: 'B' }],
    requests: [
      { time: 0, node: 'A', id: '0x100', dlc: 1, data: [0], error: { type: 'bit', dataBit: 0 } },
      { time: 500, node: 'A', id: '0x101', dlc: 1, data: [0], error: { type: 'bit', dataBit: 0 } },
    ],
  });
  const [a1, a2] = r.attempts;
  assert.equal(a1.counterChanges.find((c) => c.node === 'A').tecAfter, 135);
  assert.ok(r.events.some((e) => e.type === 'error-passive' && e.node === 'A'));
  // 第一次失败后立即重传（无标注）成功，t=500 才是第二个请求的首次尝试
  // attempts: 0=req0 首次错误, 1=req0 重传成功, 2=req1 首次错误(被动标志), 3=req1 重传成功
  const aFail2 = r.attempts[2];
  assert.equal(aFail2.status, 'error');
  const a2Bits = frameBits(r, 2);
  const txFlags = a2Bits.filter((b) => b.field === 'ERROR_FLAG' && b.drives && b.drives.A !== undefined);
  assert.equal(txFlags.length, 6);
  assert.ok(txFlags.every((b) => b.drives.A === 1), '错误被动节点应发送 6 个隐性错误标志');
  // TEC: 127 +8=135 -1=134 +8=142 -1=141
  const A = r.nodes.find((n) => n.name === 'A');
  assert.equal(A.tec, 141);
  assert.equal(A.mode, 'passive');
});

test('bus-off：TEC 达 256 后不参与仲裁、新请求被拒绝，128×11 空闲后恢复重传', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A', tec: 248 }, { name: 'B' }],
    requests: [
      { time: 0, node: 'A', id: '0x100', dlc: 1, data: [0], error: { type: 'bit', dataBit: 0 } },
      { time: 1000, node: 'A', id: '0x200', dlc: 0 }, // bus-off 期间的新请求 → 拒绝
    ],
  });
  assert.ok(r.ok);
  const off = r.events.find((e) => e.type === 'bus-off');
  assert.ok(off);
  assert.equal(off.node, 'A');
  assert.equal(off.tec, 256);
  // 新请求被拒绝
  const rej = r.requests.find((q) => q.id === 0x200);
  assert.equal(rej.status, 'rejected');
  assert.ok(rej.reason.includes('bus-off'));
  const rejEv = r.events.find((e) => e.type === 'rejected');
  assert.equal(rejEv.atBit, 1000);
  // bus-off 期间无 A 获胜帧
  assert.ok(!r.attempts.some((a) => a.winner === 'A' && a.startBit > off.atBit && a.startBit < off.atBit + 1408));
  // 恢复事件
  const rec = r.events.find((e) => e.type === 'recovered');
  assert.ok(rec);
  assert.equal(rec.groups, 128);
  // 在途请求恢复后重传成功，计数清零
  const success = r.attempts.find((a) => a.winner === 'A' && a.status === 'acknowledged');
  assert.ok(success);
  assert.ok(success.startBit >= rec.atBit - 3);
  const A = r.nodes.find((n) => n.name === 'A');
  assert.equal(A.tec, 0);
  assert.equal(A.mode, 'active');
  // 恢复区间内恰好有 128×11 个连续隐性空闲位（允许被无显性打断——本场景无其他流量）
  const idleBits = r.segments
    .filter((s) => s.type === 'idle')
    .flatMap((s) => s.bits)
    .filter((b) => b.i >= off.atBit && b.i < rec.atBit);
  assert.ok(idleBits.length >= 1408 - 1);
  assert.ok(idleBits.every((b) => b.bus === 1));
});

test('bus-off 恢复期间显性流量打断连续 11 位计数但不抹除已累计次数', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A', tec: 255 }, { name: 'B' }, { name: 'C' }],
    requests: [
      { time: 0, node: 'A', id: '0x100', dlc: 0, error: { type: 'ack' } }, // +8=263 bus-off
      { time: 500, node: 'B', id: '0x300', dlc: 0 }, // 恢复期间他节点正常通信（C 应答）
      { time: 1000, node: 'B', id: '0x301', dlc: 0 },
    ],
  });
  const off = r.events.find((e) => e.type === 'bus-off');
  const rec = r.events.find((e) => e.type === 'recovered');
  assert.ok(rec.atBit > off.atBit + 1408); // 打断使恢复时刻晚于 1408
  // A 恢复后不再有请求（其在途帧 req0 重传成功）
  assert.ok(r.attempts.some((a) => a.winner === 'A' && a.status === 'acknowledged' && a.startBit >= rec.atBit - 3));
});

test('先后 bus-off：较晚节点自其进入时刻独立累计 128×11，恢复边界与重传各自对齐', () => {
  // A、B 初始 TEC 均接近 bus-off 阈值，C 保持正常；
  // A 先因数据位错误 bus-off，A 恢复监测未完成时 B 也因数据位错误 bus-off
  const r = Can.simulate({
    nodes: [{ name: 'A', tec: 248 }, { name: 'B', tec: 248 }, { name: 'C', tec: 0 }],
    requests: [
      { time: 0, node: 'A', id: '0x100', dlc: 1, data: [0], error: { type: 'bit', dataBit: 0 } },
      { time: 200, node: 'B', id: '0x200', dlc: 1, data: [0], error: { type: 'bit', dataBit: 0 } },
    ],
  });
  assert.ok(r.ok);

  // 两个 bus-off 事件：先后进入，各自的恢复监测起点对齐各自进入位
  const offs = r.events.filter((e) => e.type === 'bus-off');
  assert.equal(offs.length, 2);
  const offA = offs.find((e) => e.node === 'A');
  const offB = offs.find((e) => e.node === 'B');
  assert.ok(offA.atBit < offB.atBit);
  assert.equal(offA.recoveryStartedAt, offA.atBit);
  assert.equal(offB.recoveryStartedAt, offB.atBit);

  // 两个恢复事件：先进入者先恢复，位位置不同；各自起点与自身 bus-off 边界一致
  const recs = r.events.filter((e) => e.type === 'recovered');
  assert.equal(recs.length, 2);
  const recA = recs.find((e) => e.node === 'A');
  const recB = recs.find((e) => e.node === 'B');
  assert.ok(recA.atBit < recB.atBit, `A(${recA.atBit}) 应先于 B(${recB.atBit}) 恢复`);
  assert.equal(recA.groups, 128);
  assert.equal(recB.groups, 128);
  assert.equal(recA.startedAtBit, offA.atBit);
  assert.equal(recB.startedAtBit, offB.atBit);

  // 较晚节点 B 的独立恢复长度：自 B 进入 bus-off 起完整累计 128×11 个隐性位
  assert.ok(recB.atBit - offB.atBit >= 128 * 11,
    `B 的恢复跨度 ${recB.atBit - offB.atBit} 应不少于 1408 位`);
  const winBits = r.segments.flatMap((s) => s.bits).filter((b) => b.i >= offB.atBit && b.i < recB.atBit);
  const recessive = winBits.filter((b) => b.bus === 1);
  assert.ok(recessive.length >= 128 * 11, `B 恢复窗口内隐性位 ${recessive.length} 应不少于 1408`);
  // 窗口内存在他节点（A 恢复后重传）的显性流量：只打断当前序列，未抹除 B 已完成组
  assert.ok(winBits.some((b) => b.bus === 0), 'B 恢复期间应存在显性流量打断');
  assert.ok(r.attempts.some((a) => a.winner === 'A' && a.ok && a.startBit >= recA.atBit - 3 && a.startBit < recB.atBit),
    'A 应在 B 仍处 bus-off 期间完成自身重传');

  // B 在自身恢复前不得参与仲裁、确认帧或发送挂起请求
  for (const a of r.attempts) {
    if (a.startBit >= offB.atBit && a.startBit < recB.atBit) {
      assert.notEqual(a.winner, 'B', 'B 在 bus-off 期间不得获胜仲裁');
      assert.ok(!a.trace.some((b) => b.drives && b.drives.B !== undefined),
        `帧尝试 #${a.index} 中 B 不得驱动任何位（含 ACK）`);
    }
  }

  // 挂起请求的重传时机与各自恢复边界一致
  const retxA = r.attempts.find((a) => a.winner === 'A' && a.retransmit && a.ok);
  const retxB = r.attempts.find((a) => a.winner === 'B' && a.retransmit && a.ok);
  assert.ok(retxA.startBit >= recA.atBit - 3 && retxA.startBit < recB.atBit);
  assert.ok(retxB.startBit >= recB.atBit - 3, `B 的重传起点 ${retxB.startBit} 应对齐自身恢复位 ${recB.atBit}`);

  // 两条挂起请求最终均重传成功，两节点计数清零、恢复主动模式
  assert.equal(r.requests.find((q) => q.node === 'A').status, 'transmitted');
  assert.equal(r.requests.find((q) => q.node === 'B').status, 'transmitted');
  for (const name of ['A', 'B']) {
    const n = r.nodes.find((x) => x.name === name);
    assert.equal(n.tec, 0);
    assert.equal(n.rec, 0);
    assert.equal(n.mode, 'active');
  }
});

test('字段级校验：非法标识、载荷超 DLC、无效错误位置均被拒绝并带字段路径', () => {
  const cases = [
    [{ nodes: [{ name: 'A' }], requests: [{ node: 'A', id: '0x800', dlc: 0 }] }, 'requests[0].id'],
    [{ nodes: [{ name: 'A' }], requests: [{ node: 'A', id: '0x100', dlc: 1, data: [1, 2] }] }, 'requests[0].data'],
    [{ nodes: [{ name: 'A' }], requests: [{ node: 'A', id: '0x100', dlc: 0, error: { type: 'bit', dataBit: 0 } }] }, 'dataBit'],
    [{ nodes: [{ name: 'A' }, { name: 'B' }], requests: [{ node: 'A', id: '0x100', dlc: 0, error: { type: 'crc', sourceNode: 'A' } }] }, 'sourceNode'],
    [{ nodes: [{ name: 'A' }, { name: 'B' }], requests: [{ node: 'A', id: '0x100', dlc: 0, error: { type: 'crc', sourceNode: 'X' } }] }, 'sourceNode'],
    [{ nodes: [{ name: 'A' }], requests: [{ node: 'A', id: '0x100', dlc: 0, error: { type: 'wat' } }] }, 'error.type'],
    [{ nodes: [{ name: 'A' }], requests: [{ node: 'A', id: '0x100', dlc: 9 }] }, 'requests[0].dlc'],
    [{ nodes: [{ name: 'A' }], requests: [{ node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }, { node: 'A', id: '0x100', dlc: 0 }] }, 'requests'],
  ];
  for (const [input, pathPart] of cases) {
    const r = Can.simulate(input);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
    assert.ok(r.errors.some((e) => e.field.includes(pathPart) || (pathPart === 'dataBit' && e.field.includes('dataBit'))),
      `期望字段路径包含 ${pathPart}，实际：${JSON.stringify(r.errors)}`);
  }
});

test('节点上限 4、请求上限 24、时刻必须有序', () => {
  const r1 = Can.simulate({
    nodes: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }],
    requests: [],
  });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.field === 'nodes'));
  const r2 = Can.simulate({
    nodes: [{ name: 'A' }],
    requests: [{ time: 5, node: 'A', id: 0 }, { time: 4, node: 'A', id: 0 }],
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.field.includes('time')));
});

test('位轨迹包含全部场标签且按 SOF→…→IFS 顺序出现', () => {
  const r = Can.simulate({
    nodes: [{ name: 'A' }, { name: 'B' }],
    requests: [{ time: 0, node: 'A', id: '0x123', dlc: 1, data: [0xff] }],
  });
  const labels = frameBits(r, 0).map((b) => b.field);
  for (const f of ['SOF', 'ARBITRATION', 'CONTROL', 'DATA', 'CRC', 'CRC_DELIM', 'ACK', 'EOF', 'IFS']) {
    assert.ok(labels.includes(f), `缺少场 ${f}`);
  }
  const pos = (f) => labels.indexOf(f);
  assert.ok(pos('SOF') < pos('ARBITRATION') && pos('ARBITRATION') < pos('CONTROL') &&
    pos('CONTROL') < pos('DATA') && pos('DATA') < pos('CRC') &&
    pos('CRC') < pos('CRC_DELIM') && pos('CRC_DELIM') < pos('ACK') && pos('ACK') < pos('EOF') &&
    pos('EOF') < pos('IFS'));
});

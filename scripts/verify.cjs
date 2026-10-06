'use strict';

/**
 * 一次性验收（verify）：
 *   阶段 1  node --test 全量代码测试（仲裁 / 填充 / CRC / ACK / 被动错误 / bus-off 恢复 / 字段校验）
 *   阶段 2  构建检查（语法 + 页面资源 + dist 产出）
 *   阶段 3  启动真实 HTTP 服务，健康检查与页面资源冒烟
 *   阶段 4  通过 HTTP API 验证可观察结果：正常仲裁 / 被动错误 / 单节点 bus-off 恢复 /
 *           双节点先后 bus-off 各自独立恢复 / 非法输入字段级反馈
 *
 * 任一阶段失败即以非零码退出，退出码如实反映验收结果。
 */

const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.VERIFY_PORT || '8090';
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw lastErr || new Error('healthz 未就绪');
}

async function api(payload) {
  const r = await fetch(`${BASE}/api/simulate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json() };
}

async function main() {
  /* ---------- 阶段 1：代码测试 ---------- */
  section('阶段 1：node --test 代码测试');
  try {
    run(process.execPath, ['--test', 'test/']);
    check('单元测试全部通过', true);
  } catch {
    check('单元测试全部通过', false);
    process.exit(1);
  }

  /* ---------- 阶段 2：构建检查 ---------- */
  section('阶段 2：构建检查');
  try {
    run(process.execPath, ['scripts/build.cjs']);
    check('构建检查通过', true);
  } catch {
    check('构建检查通过', false);
    process.exit(1);
  }

  /* ---------- 阶段 3：启动 HTTP 服务 + 冒烟 ---------- */
  // 若由 Compose 编排（depends_on: web healthy），先冒烟编排内的 web 服务
  const WEB_BASE = process.env.VERIFY_WEB_BASE;
  if (WEB_BASE) {
    section(`阶段 3a：冒烟 Compose 编排内的 web 服务（${WEB_BASE}）`);
    try {
      const r = await fetch(`${WEB_BASE}/healthz`);
      const j = await r.json();
      check('编排 web /healthz 返回 200', r.status === 200 && j.status === 'ok');
      const page = await (await fetch(`${WEB_BASE}/`)).text();
      check('编排 web 页面可访问', page.includes('执行回放仿真'));
    } catch (e) {
      check('编排 web 服务冒烟', false, e.message);
    }
  }

  section(`阶段 3b：启动独立 HTTP 服务（PORT=${PORT}）并冒烟`);  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });

  let exitCode = 0;
  try {
    await waitHealthy(8000);
    check('/healthz 返回 200', true);
    const h = await (await fetch(`${BASE}/healthz`)).json();
    check('健康响应含服务名与限制', h.service === 'can-bus-replay' && h.limits.maxNodes === 4 && h.limits.maxRequests === 24,
      JSON.stringify(h));

    for (const asset of ['/', '/app.js', '/style.css', '/engine.js']) {
      const r = await fetch(`${BASE}${asset}`);
      check(`页面资源可访问 ${asset}`, r.status === 200, `HTTP ${r.status}`);
    }
    const idx = await (await fetch(`${BASE}/`)).text();
    check('页面包含逐位回放入口', idx.includes('执行回放仿真') && idx.includes('位序轨迹'));

    /* ---------- 阶段 4：三类可观察结果（经 HTTP API） ---------- */
    section('阶段 4a：正常仲裁（低标识符获胜 + 首个违规证据）');
    const normal = await api({
      nodes: [{ name: 'CAM-A', tec: 0 }, { name: 'CAM-B', tec: 0 }, { name: 'RADAR', tec: 0 }],
      requests: [
        { time: 0, node: 'CAM-A', id: '0x200', dlc: 2, data: '11 22' },
        { time: 0, node: 'CAM-B', id: '0x100', dlc: 1, data: 'AA' },
        { time: 0, node: 'RADAR', id: '0x180', dlc: 0 },
      ],
    });
    check('API 返回 200', normal.status === 200);
    {
      const r = normal.body;
      check('同刻仅最低 ID 帧获胜 CAM-B(0x100)', r.attempts[0].winner === 'CAM-B' && r.attempts[0].frameIdHex === '0x100');
      const losers = r.attempts[0].arbitration.loserEvidence;
      check('两个失败节点均给出仲裁证据', losers.length === 2);
      const radar = losers.find((e) => e.node === 'RADAR');
      check('证据定位「发隐性、总线显性」位置', radar && radar.sent === 1 && radar.bus === 0 && typeof radar.globalBit === 'number',
        JSON.stringify(radar));
      check('三条请求最终全部发送成功', r.requests.every((q) => q.status === 'transmitted'));
      check('各节点仍处主动错误模式', r.nodes.every((n) => n.mode === 'active'));
      check('获胜帧位轨迹覆盖 SOF…IFS',
        ['SOF', 'ARBITRATION', 'CONTROL', 'DATA', 'CRC', 'ACK', 'EOF', 'IFS']
          .every((f) => r.attempts[0].trace.some((b) => b.field === f)));
    }

    section('阶段 4b：被动错误（TEC≥128 后错误标志为 6 个隐性位）');
    const passive = await api({
      nodes: [{ name: 'CAM-A', tec: 126 }, { name: 'CAM-B', tec: 0 }],
      requests: [
        { time: 0, node: 'CAM-A', id: '0x100', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } },
        { time: 400, node: 'CAM-A', id: '0x101', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } },
      ],
    });
    check('API 返回 200', passive.status === 200);
    {
      const r = passive.body;
      check('出现 error-passive 状态事件', r.events.some((e) => e.type === 'error-passive' && e.node === 'CAM-A'));
      const A = r.nodes.find((n) => n.name === 'CAM-A');
      check('CAM-A 最终为 passive 模式', A && A.mode === 'passive' && A.tec >= 128, `TEC=${A?.tec}`);
      // 第二次标注故障的首次尝试（index=2：首帧失败、首帧重传成功、次帧失败…）
      const fail2 = r.attempts.find((a) => a.annotation?.type === 'bit' && a.winnerRequestIndex === 1);
      check('被动帧存在', !!fail2);
      const flags = fail2.trace.filter((b) => b.field === 'ERROR_FLAG' && b.drives && b.drives['CAM-A'] !== undefined);
      check('错误被动标志为 6 个隐性位', flags.length === 6 && flags.every((b) => b.drives['CAM-A'] === 1),
        `flags=${flags.map((b) => b.drives['CAM-A']).join('')}`);
      check('请求最终经自动重传成功', r.requests.every((q) => q.status === 'transmitted'));
    }

    section('阶段 4c：bus-off（拒绝新请求 + 128×11 空闲恢复）');
    const busoff = await api({
      nodes: [{ name: 'CAM-A', tec: 248 }, { name: 'CAM-B', tec: 0 }, { name: 'RADAR', tec: 0 }],
      requests: [
        { time: 0, node: 'CAM-A', id: '0x100', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } },
        { time: 600, node: 'CAM-B', id: '0x300', dlc: 0 },
        { time: 1000, node: 'CAM-A', id: '0x200', dlc: 0 }, // bus-off 期间新请求 → 拒绝
      ],
    });
    check('API 返回 200', busoff.status === 200);
    {
      const r = busoff.body;
      const off = r.events.find((e) => e.type === 'bus-off');
      check('CAM-A 进入 bus-off（TEC=256）', off && off.node === 'CAM-A' && off.tec === 256, JSON.stringify(off));
      const rej = r.requests.find((q) => q.id === 0x200);
      check('bus-off 期间新请求被拒绝', rej && rej.status === 'rejected');
      const rejEv = r.events.find((e) => e.type === 'rejected');
      check('拒绝事件发生在请求时刻（位 1000）', rejEv && rejEv.atBit === 1000, `at=${rejEv?.atBit}`);
      const rec = r.events.find((e) => e.type === 'recovered');
      check('128 次 11 连续隐性位后恢复', rec && rec.groups === 128);
      check('恢复后在途请求自动重传成功',
        r.attempts.some((a) => a.winner === 'CAM-A' && a.ok && a.startBit >= rec.atBit - 3));
      const A = r.nodes.find((n) => n.name === 'CAM-A');
      check('恢复后 TEC/REC 清零且模式为 active', A.tec === 0 && A.rec === 0 && A.mode === 'active',
        JSON.stringify(A));
      check('恢复期间他节点正常通信不抹除已累计次数',
        rec.atBit > off.atBit + 1408, `off=${off.atBit} rec=${rec.atBit}`);
    }

    section('阶段 4d：双节点先后 bus-off（恢复资格按各自进入时刻独立累计）');
    const dual = await api({
      nodes: [{ name: 'A', tec: 248 }, { name: 'B', tec: 248 }, { name: 'C', tec: 0 }],
      requests: [
        { time: 0, node: 'A', id: '0x100', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } },   // A 首先 bus-off
        { time: 300, node: 'B', id: '0x200', dlc: 1, data: '00', error: { type: 'bit', dataBit: 0 } }, // A 监测期间 B 也 bus-off
        { time: 1600, node: 'C', id: '0x300', dlc: 0 }, // B 恢复窗口内的他节点显性流量
      ],
    });
    check('API 返回 200', dual.status === 200);
    {
      const r = dual.body;
      const offA = r.events.find((e) => e.type === 'bus-off' && e.node === 'A');
      const offB = r.events.find((e) => e.type === 'bus-off' && e.node === 'B');
      const recA = r.events.find((e) => e.type === 'recovered' && e.node === 'A');
      const recB = r.events.find((e) => e.type === 'recovered' && e.node === 'B');
      check('A、B 先后进入 bus-off，且 B 进入时 A 仍在监测期',
        offA && offB && recA && offA.atBit < offB.atBit && offB.atBit < recA.atBit,
        `offA=${offA?.atBit} offB=${offB?.atBit} recA=${recA?.atBit}`);
      check('两个恢复事件先后发生、位位置不同（不得同位同时恢复）',
        recA && recB && recA.atBit < recB.atBit, `recA=${recA?.atBit} recB=${recB?.atBit}`);
      check('B 的恢复监测自 B 自身 bus-off 时刻起算',
        recB && offB && recB.startedAtBit === offB.atBit && offB.recoveryStartedAt === offB.atBit,
        `startedAt=${recB?.startedAtBit} offB=${offB?.atBit}`);
      // 较晚节点 B 的独立恢复长度：自 B 进入 bus-off 起亲自观察满 128×11 个隐性位
      const winB = r.segments.flatMap((s) => s.bits).filter((b) => b.i >= offB.atBit && b.i < recB.atBit);
      const recCountB = winB.filter((b) => b.bus === 1).length;
      check('较晚节点 B 独立累计满 128×11 隐性位才恢复',
        recCountB >= 1408 && recB.atBit - offB.atBit >= 1408,
        `窗口=${recB.atBit - offB.atBit} 隐性位=${recCountB}`);
      check('B 恢复窗口内他节点显性流量只打断当前序列（恢复仍完成）',
        winB.some((b) => b.bus === 0));
      // B 在自身恢复边界前不参与仲裁、不确认帧
      const droveB = r.segments.flatMap((s) => s.bits)
        .filter((b) => b.i >= offB.atBit && b.i < recB.atBit && b.drives && 'B' in b.drives);
      check('B 恢复前不参与仲裁、不确认帧、不发送挂起请求', droveB.length === 0,
        `违规位=${droveB.map((b) => b.i).join(',')}`);
      // 挂起请求的重传时机与各自恢复边界一致
      const retxA = r.attempts.find((a) => a.winner === 'A' && a.ok);
      const retxB = r.attempts.find((a) => a.winner === 'B' && a.ok);
      check('A 的挂起请求在 A 自身恢复边界重传', retxA && retxA.startBit === recA.atBit,
        `start=${retxA?.startBit} recA=${recA.atBit}`);
      check('B 的挂起请求在 B 自身恢复边界重传且成功',
        retxB && retxB.retransmit && retxB.startBit === recB.atBit,
        `start=${retxB?.startBit} recB=${recB.atBit}`);
      check('两节点恢复后 TEC/REC 清零、模式主动', ['A', 'B'].every((n) => {
        const x = r.nodes.find((q) => q.name === n);
        return x && x.tec === 0 && x.rec === 0 && x.mode === 'active';
      }), JSON.stringify(r.nodes));
      check('三条请求最终全部发送成功', r.requests.every((q) => q.status === 'transmitted'));
    }

    section('阶段 4e：非法输入字段级反馈（并确认不产生结论）');
    const bad = await api({
      nodes: [{ name: 'A' }],
      requests: [{ node: 'A', id: '0x800', dlc: 2, data: [1, 2, 3], error: { type: 'bit', dataBit: 99 } }],
    });
    check('非法输入返回 400', bad.status === 400);
    check('字段路径覆盖 id / data / dataBit',
      bad.body.errors.some((e) => e.field.includes('.id')) &&
      bad.body.errors.some((e) => e.field.includes('.data')) &&
      bad.body.errors.some((e) => e.field.includes('dataBit')));
    check('响应不含旧结论字段', bad.body.attempts === undefined);
  } catch (e) {
    failures++;
    console.error('  ✗ 验收过程发生异常：', e);
  } finally {
    server.kill('SIGTERM');
  }

  section(failures === 0 ? '验收结论：通过 ✅' : `验收结论：失败（${failures} 项）❌`);
  exitCode = failures === 0 ? 0 : 1;
  // 等待服务进程退出
  await new Promise((res) => server.on('exit', res)).catch(() => {});
  process.exit(exitCode);
}

main();

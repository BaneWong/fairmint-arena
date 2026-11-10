#!/usr/bin/env node
/**
 * FairMint Arena · 本地桥接服务（仅绑定 127.0.0.1）
 *
 *   node server.mjs          # http://127.0.0.1:8790
 *   node server.mjs 8791     # 自定义端口
 *
 * 静态前端 + 币安 Agentic Wallet（baw）扫码登录 + 通用 contract-call preview/execute。
 * 公开只读数据（进度 / 地址权益 / 提示词）由前端直连 BSC RPC，无需本服务；
 * 只有「钱包动作」走本桥接 —— 这就是「AI 钱包专属」的含义。
 *
 * 安全边界：
 *  - 仅 127.0.0.1，不暴露局域网。
 *  - to 白名单：FMA2 合约 + BSC USDT，桥接不能碰其它合约。
 *  - execute 三重门：confirm===true && 预览 simulationCode==='000000000' && devMode 仍启用。
 *  - 不打印 / 不外泄会话令牌、私钥；QR 仅以 dataURL 回给本机前端。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baw } from '../mint/lib/run.mjs';
import {
  walletStatus,
  startLogin,
  loginQrPngPath,
} from '../mint/lib/wallet-login.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = __dirname;
const PORT = Number(process.argv[2] || process.env.FMA_PORT || 8790);
const HOST = '127.0.0.1';

const CHAIN = '56';
const CONTRACT = '0x30bbed35e8ea52700338869e66ae2be139932dd1';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const ALLOWED_TO = new Set([CONTRACT, USDT]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') && typeof body !== 'string'
    ? JSON.stringify(body)
    : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const isAddr = (a) => /^0x[a-f0-9]{40}$/.test(String(a || '').toLowerCase());
const isHex = (h) => /^0x([0-9a-fA-F]{2})*$/.test(String(h || ''));
const isWei = (v) => /^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(String(v ?? ''));

async function bscAddress() {
  const r = await baw(['wallet', 'address'], { timeoutMs: 20_000 });
  const rows = r.json?.data?.addresses || [];
  const row = rows.find((x) => String(x.binanceChainId) === CHAIN);
  return row?.address || null;
}

async function fetchDevMode() {
  const r = await baw(['wallet', 'settings'], { timeoutMs: 20_000 });
  return r.json?.data?.devMode || null;
}

// devMode.expiresAt 可能是 Unix 秒、毫秒或 ISO 字符串；统一成 ms 比较。
function devModeActive(dev) {
  if (!dev?.enabled) return false;
  const e = dev.expiresAt;
  if (e == null || e === '') return true;
  const ms = typeof e === 'number' ? (e < 1e12 ? e * 1000 : e) : Date.parse(e);
  return !Number.isFinite(ms) || ms > Date.now();
}

// requestId -> 预览快照（execute 门禁靠它，不信任前端回传的 simulationCode）
const previews = new Map();
function prunePreviews() {
  const now = Date.now();
  for (const [id, p] of previews) {
    const exp = p.expiresAt ? Number(p.expiresAt) : 0;
    if ((exp && exp < now) || now - p.at > 10 * 60_000) previews.delete(id);
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  try {
    if (u.pathname === '/api/wallet/status' && (req.method === 'GET' || req.method === 'POST')) {
      const st = await walletStatus({ quick: true });
      let address = null;
      let dev = null;
      if (st.connected) {
        [address, dev] = await Promise.all([bscAddress(), fetchDevMode()]);
      }
      send(res, 200, {
        ok: true,
        connected: Boolean(st.connected),
        status: st.status,
        address,
        devMode: dev,
        devModeActive: devModeActive(dev),
        verify: st.verify || null,
      });
      return;
    }

    if (u.pathname === '/api/wallet/login/start' && req.method === 'POST') {
      const r = await startLogin();
      send(res, r.ok ? 200 : 422, r);
      return;
    }

    if (u.pathname === '/api/wallet/qr.png' && req.method === 'GET') {
      fs.readFile(loginQrPngPath(), (err, data) => {
        if (err) { send(res, 404, 'qr not found', 'text/plain; charset=utf-8'); return; }
        send(res, 200, data, 'image/png');
      });
      return;
    }

    if (u.pathname === '/api/tx/preview' && req.method === 'POST') {
      const body = await readBody(req);
      const st = await walletStatus({ quick: true });
      if (!st.connected) { send(res, 409, { ok: false, error: 'wallet_not_connected' }); return; }
      const dev = await fetchDevMode();
      if (!devModeActive(dev)) { send(res, 409, { ok: false, error: 'dev_mode_off', devMode: dev }); return; }
      const from = await bscAddress();
      if (!from) { send(res, 409, { ok: false, error: 'no_bsc_address' }); return; }

      const to = String(body.to || '').toLowerCase();
      if (!ALLOWED_TO.has(to)) { send(res, 400, { ok: false, error: 'to_not_allowed' }); return; }
      const value = String(body.value ?? '0');
      if (!isWei(value)) { send(res, 400, { ok: false, error: 'bad_value' }); return; }
      const inputData = String(body.inputData || '0x');
      if (!isHex(inputData)) { send(res, 400, { ok: false, error: 'bad_inputData' }); return; }

      const r = await baw(
        ['contract-call', 'preview', '--binanceChainId', CHAIN, '--from', from,
         '--to', to, '--value', value, '--inputData', inputData],
        { timeoutMs: 60_000 },
      );
      const data = r.json?.data;
      if (!r.ok || r.json?.success === false || !data?.requestId) {
        const err = r.json?.error;
        send(res, 200, {
          ok: false,
          error: err?.message || r.stderr || r.stdout || 'preview_fail',
          code: err?.code ?? null,
          blockLevel: err?.data?.blockLevel || null,
          risks: err?.data?.risks || data?.risks || null,
        });
        return;
      }
      prunePreviews();
      const simulationCode = data.simulationResult?.simulationCode ?? null;
      previews.set(data.requestId, {
        simulationCode, to, value, inputData, from,
        expiresAt: data.expiresAt ?? null, at: Date.now(),
      });
      send(res, 200, {
        ok: true,
        requestId: data.requestId,
        simulationCode,
        parsedTx: data.parsedTx || null,
        simulationResult: data.simulationResult || null,
        risks: data.risks || null,
        tokenInfos: data.tokenInfos || null,
        requireConfirmation: Boolean(data.requireConfirmation),
        expiresAt: data.expiresAt ?? null,
      });
      return;
    }

    if (u.pathname === '/api/tx/execute' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.confirm !== true) { send(res, 400, { ok: false, error: 'confirm_required' }); return; }
      const requestId = String(body.requestId || '');
      const p = previews.get(requestId);
      if (!p) { send(res, 404, { ok: false, error: 'preview_not_found_or_expired' }); return; }
      if (p.simulationCode !== '000000000') {
        send(res, 422, { ok: false, error: 'simulation_not_clean', simulationCode: p.simulationCode });
        return;
      }
      const dev = await fetchDevMode();
      if (!devModeActive(dev)) { send(res, 409, { ok: false, error: 'dev_mode_off' }); return; }

      const r = await baw(['contract-call', 'execute', '--requestId', requestId], { timeoutMs: 90_000 });
      const data = r.json?.data;
      if (!r.ok || r.json?.success === false) {
        const err = r.json?.error;
        send(res, 200, {
          ok: false,
          error: err?.message || r.stderr || r.stdout || 'execute_fail',
          code: err?.code ?? null,
        });
        return;
      }
      previews.delete(requestId);
      send(res, 200, {
        ok: true,
        orderId: data?.orderId || null,
        status: data?.status || null,
        txHash: data?.txHash || null,
        message: data?.message || null,
      });
      return;
    }

    // 静态：只服务前端入口与 web 资源，绝不泄露 server.mjs / package.json / *.bak.html
    let rel = u.pathname === '/' ? '/index.html' : u.pathname;
    rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(WEB, rel);
    const ext = path.extname(file).toLowerCase();
    const blocked = /(^|[/\\])(server\.mjs|package\.json|.*\.bak\.html|.*\.mjs)$/i.test(rel);
    if (!file.startsWith(WEB) || blocked || !MIME[ext]) {
      send(res, 404, 'not found', 'text/plain; charset=utf-8');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) { send(res, 404, 'not found', 'text/plain; charset=utf-8'); return; }
      send(res, 200, data, MIME[ext]);
    });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message || String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FairMint Arena bridge → http://${HOST}:${PORT}`);
  console.log(`bind ${HOST} only · to whitelist: FMA2 + USDT · execute gated by confirm + simulation 000000000 + devMode`);
});
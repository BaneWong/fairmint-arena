# Agent Ascent 网页优化审计报告

> 基于 `modern-web-guidance`（performance / security / efficient-background-processing / defer-rendering-heavy-content）+ `frontend-ui-engineering` 技能规范，对 `index.html`（1767 行单文件 SPA）的全面审查。

---

## 一、性能（Performance）— 高优先级

### 1.1 单文件 125 KB 内联 JS 阻塞渲染 — **严重**
**现状**：全部 JS（~900 行，含 ethers.js + 业务逻辑）内联在 `<script>` 块中，位于 `</body>` 前，虽不阻塞解析但阻塞执行。

**影响**：
- 125 KB 的 HTML + 内联 JS 在 3G 网络下首屏加载可能 > 5 秒
- 浏览器必须下载并解析整个 HTML 才能开始执行 JS（链上数据读取、排行榜扫描等）

**建议**：
```html
<!-- 改为：defer 加载外部 JS -->
<script defer src="/app.js"></script>
```
将 JS 拆分为外部文件，利用 `defer` 让浏览器并行下载 + 解析，不阻塞 HTML 渲染。

### 1.2 字体加载 — **中等**
**现状**（第 23 行）：
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="..." media="print" onload="this.media='all'" />
```
使用了 `media="print" onload` 技术（异步加载字体），这是正确的做法。

**但**：缺少 `font-display: swap`，且加载了 3 个字体家族共 9 个权重（Orbitron 3 + Share Tech Mono 1 + Noto Sans SC 3），实际只用了其中几个。

**建议**：
- 在 CSS `@font-face` 中加 `font-display: swap`
- 考虑子集化 Noto Sans SC（只加载用到的字符），或改用 variable font
- 对 `Orbitron` 和 `Share Tech Mono`（等宽科技字体）使用 `preload` 而非 `preconnect`，因为它们在首屏 hero 区域可见

### 1.3 轮询间隔 15 秒 — **中等**
**现状**（第 1763 行）：
```js
setInterval(()=>refresh().catch(()=>{}),15000);
```

**建议**：使用 `contentvisibilityautostatechange` 或 `IntersectionObserver` 在用户不查看页面时暂停轮询：
```js
// 当 leaderboard 区域不在视图中时，暂停或降低刷新频率
const lbSection = document.getElementById('leaderboard');
const observer = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) {
    // 高频率刷新
  } else {
    // 降低或暂停
  }
}, { rootMargin: '500px' });
observer.observe(lbSection);
```

### 1.4 排行榜全量扫描 — **中等**
**现状**（第 1218-1267 行）：`loadLeaderboard()` 从部署块开始扫描所有 `Transfer` 事件，块跨度可能非常大。

**风险**：
- 首次加载时扫描数万块可能导致主线程阻塞
- 没有 `scheduler.yield()` 或任务切片

**建议**：
```js
async function yieldToMain() {
  if ('scheduler' in window && 'yield' in scheduler) {
    return await scheduler.yield();
  }
  return new Promise(resolve => setTimeout(resolve, 0));
}

// 在扫描循环中每处理 N 个块就 yield
while(from <= latest) {
  // ... 处理块 ...
  if ((to - from) % 5000 === 0) await yieldToMain();
}
```

### 1.5 Cloudflare 分析脚本 — **低**
**现状**（第 1765 行）：
```html
<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" ...></script>
```
第三方脚本无 SRI 校验、无 `referrerpolicy`。

**建议**：
```html
<script 
  type="module" 
  src="https://static.cloudflareinsights.com/beacon.min.js" 
  integrity="sha384-..." 
  crossorigin="anonymous"
  referrerpolicy="no-referrer"
  data-cf-beacon='...'
></script>
```

---

## 二、安全（Security）— 高优先级

### 2.1 无 CSP（Content Security Policy）— **严重**
**现状**：页面没有任何 `<meta http-equiv="Content-Security-Policy">` 或 HTTP 头 CSP。

**风险**：
- 内联脚本（整个 `<script>` 块）可被 XSS 注入任意代码
- 无 `object-src 'none'`、`base-uri 'none'` 等基础防护

**建议**（静态 HTML 使用 hash-based CSP）：
```html
<meta http-equiv="Content-Security-Policy" 
  content="default-src 'self'; script-src 'sha256-<你的脚本哈希>'; 
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; 
  font-src 'self' https://fonts.gstatic.com data:; 
  img-src 'self' data: https:; object-src 'none'; base-uri 'none'; 
  frame-ancestors 'none';">
```

**注意**：由于脚本是内联的，必须使用 `sha256-`/`sha384-` 哈希。建议将脚本提取到外部文件后使用 nonce 或 hash。

### 2.2 `innerHTML` 大量使用 — **严重**
**现状**：以下位置使用了 `innerHTML`（第 1091、1103、1193、1202、1204、1216 行等）：
```js
$("phaseMap").innerHTML = chips.join("");
$("rulesBody").innerHTML = RULES.map(...).join("");
$("lbBody").innerHTML = ...;
```

**风险**：虽然当前内容是可控的，但任何未来修改如果引入了用户可控数据，就会变成 XSS 漏洞。

**建议**：改用 `textContent` 或 `setHTML()`（Sanitizer API）：
```js
// 方案 A：使用 DocumentFragment（推荐）
const frag = document.createDocumentFragment();
chips.forEach(chip => frag.appendChild(chip));
$("phaseMap").appendChild(frag);

// 方案 B：使用 setHTML（现代浏览器）
if (el.setHTML) {
  el.setHTML(htmlString, { SanitizerAPI: sanitizer });
}
```

### 2.3 `document.execCommand("copy")` — **中等**
**现状**（第 1588、1749 行）：
```js
document.execCommand("copy");
```
`execCommand` 已被废弃，现代浏览器推荐 `navigator.clipboard.writeText()`。

**建议**：你的代码已经做了 fallback（先 `clipboard.writeText`，失败再 `execCommand`），方向正确。但建议：
- 移除 `execCommand` fallback（现代浏览器都已支持 `clipboard.writeText`）
- 或者保留但标注为 deprecated

### 2.4 无 HSTS、X-Frame-Options 等安全头 — **中等**
**现状**：这些是服务器端配置，不在 HTML 内。但你的 server.mjs 可能没有设置。

**检查** `server.mjs` 是否有以下 HTTP 响应头：
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`

### 2.5 ethers.js CDN 无 SRI — **低**
**现状**（第 744 行）：
```html
<script src="https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js"></script>
```
无 `integrity`、无 `crossorigin`。

**建议**：
```html
<script 
  src="https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js"
  integrity="sha384-..." 
  crossorigin="anonymous"
></script>
```

---

## 三、可访问性（Accessibility）— 中等优先级

### 3.1 纯视觉状态指示 — **中等**
**现状**：多处使用颜色区分状态（绿色=可用，红色=错误，灰色=禁用），但没有足够的文本/图标辅助。

**问题**：
- `.msg.err` 和 `.msg.ok` 仅靠颜色区分
- CRT 扫描线效果（`.scanlines`）可能影响文字可读性

**建议**：
```css
.msg.err::before { content: "⚠ "; }
.msg.ok::before { content: "✓ "; }
```

### 3.2 动态内容缺少 ARIA 更新 — **低**
**现状**：`renderStats()`、`renderOrder()` 等函数频繁更新 DOM 但缺少 `aria-live` 区域。

**建议**：
```html
<div aria-live="polite" aria-atomic="true" id="liveStatus"></div>
```

### 3.3 表单输入无障碍 — **低**
**现状**：
- `#paidNInput` 没有 `<label>`
- `#equityAddr` 有 placeholder 但没有关联 label

**建议**：
```html
<label for="equityAddr" class="sr-only">钱包地址</label>
<input type="text" id="equityAddr" aria-label="输入钱包地址查询权益" ... />
```

---

## 四、CSS / 渲染优化 — 低优先级

### 4.1 CRT 效果过多 — **低**
**现状**：5 个固定定位覆盖层（`.grid-bg`, `.scanlines`, `.vignette`, `.crt-sweep`, `.crt-glitch`），全部使用 `position: fixed` + `pointer-events: none`。

**影响**：在低端设备上可能导致复合层过多、GPU 内存占用高。

**建议**：
- 对 `prefers-reduced-motion: reduce` 用户已正确处理（隐藏了 CRT 效果）
- 考虑将部分效果合并为单个层
- 移除 `.crt-sweep` 和 `.crt-glitch` 的 `will-change`（它们实际上没有 transform 动画触发复合）

### 4.2 无 `content-visibility` 优化 — **低**
**现状**：所有 `<section>` 都立即渲染，包括排行榜（可能包含大量 DOM 节点）。

**建议**：
```css
section:not(:first-of-type) {
  content-visibility: auto;
  contain-intrinsic-size: 400px;
}
```

---

## 五、代码质量 — 低优先级

### 5.1 全局变量过多 — **低**
**现状**：`state`, `account`, `wallet`, `payAsset`, `selectedShares` 等全部是全局变量。

**建议**：封装为模块：
```js
const App = (() => {
  let state = {};
  let wallet = { connected: false, address: null };
  // ...
  return { init, render, ... };
})();
```

### 5.2 `CONTRACT` 和 `NEW_CONTRACT` 相同值 — **低**
**现状**（第 748-749 行）：
```js
const CONTRACT = "0x17E...";
const NEW_CONTRACT = "0x17E..."; // 相同地址
```
`NEW_CONTRACT` 无意义。

### 5.3 `BNB_PRICE_USD = 690` 硬编码 — **低**
**现状**（第 784 行）：价格硬编码，不会更新。

**建议**：从 RPC 或 API 获取实时价格。

---

## 六、优化优先级总结

| 优先级 | 问题 | 预估工作量 | 影响 |
|--------|------|-----------|------|
| 🔴 P0 | 添加 CSP | 1-2h | 防 XSS |
| 🔴 P0 | 替换 innerHTML | 2-3h | 防 XSS |
| 🔴 P0 | ethers.js CDN 加 SRI | 15min | 防供应链攻击 |
| 🟡 P1 | JS 提取为外部文件 + defer | 1-2h | 加载性能 |
| 🟡 P1 | 排行榜扫描加 yield | 30min | 主线程响应 |
| 🟡 P1 | 字体优化（display: swap + 子集） | 1h | 首屏渲染 |
| 🟡 P1 | 服务器安全头（HSTS/X-Frame） | 30min | 安全 |
| 🟢 P2 | IntersectionObserver 暂停轮询 | 30min | 电池/带宽 |
| 🟢 P2 | content-visibility 延迟渲染 | 30min | 滚动性能 |
| 🟢 P2 | 无障碍改进（aria-live, labels） | 1h | 可访问性 |
| 🟢 P2 | 代码重构（模块封装） | 2-3h | 可维护性 |

---

## 快速执行清单

```bash
# 1. 生成 SRI hash
openssl dgst -sha384 -binary node_modules/ethers/dist/ethers.umd.min.js | openssl base64 -A

# 2. 生成 CSP hash（提取脚本后）
openssl dgst -sha384 -binary app.js | openssl base64 -A

# 3. 检查 server.mjs 安全头
grep -i "strict-transport\|x-frame\|x-content-type\|referrer-policy" server.mjs
```

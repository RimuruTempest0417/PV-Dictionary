/* 每個請求的上下文（AsyncLocalStorage）
 *
 * 為什麼需要：稽核紀錄與錯誤日誌都要知道「這一筆是不是自動化檢查造成的」，
 * 而寫入點（lib/audit.js 的 logAudit、server.js 的錯誤處理）拿不到 req 物件本身。
 *
 * 為什麼不能用模組層的變數：Node 是單執行緒，但路由之間會在 await 交錯
 * （Supabase 模式的 hydrate/flush 就是非同步）—— 用全域變數會把 A 請求的標記
 * 寫進 B 請求的紀錄裡。AsyncLocalStorage 會跟著非同步鏈走，才是對的工具。
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function run(context, fn) {
    return storage.run(context || {}, fn);
}

function get() {
    return storage.getStore() || {};
}

/* 這一筆紀錄/動作是否來自自動化檢查（帶簽章的 X-PV-Self-Test） */
function isSelfTest() {
    return Boolean(get().isSelfTest);
}

module.exports = { run, get, isSelfTest };

/* Vercel Web Analytics 的前置 shim
 *
 * ★ 為什麼要獨立一個檔案：Vercel 的整合會把這段塞成 HTML 裡的**行內 script**，
 *   而本專案的 CSP 是嚴格的 `script-src 'self'`（不要 unsafe-inline）——
 *   行內 script 會被瀏覽器擋掉、並產生 CSP 違規（檢查腳本會抓到）。
 *   放成同源檔案就沒有這個問題，功能完全一樣。
 */
window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };

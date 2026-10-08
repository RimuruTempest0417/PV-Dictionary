/* 公開寫入端點的節流（A-4）
 *
 * 為什麼要有一支共用的：本系統對外只開放「登入」一種寫入（已有 IP 與帳號雙軌鎖定）。
 * 一旦新增任何「未登入也能寫」的端點（錯誤回報就是第一個），如果沒有節流，等於把
 * 資料庫的寫入額度送給任何路過的人 —— 學校規模被灌爆一次就夠麻煩了。
 *
 * 設計取捨：
 *   - 記憶體計數（Map）：serverless 每個實例各算一份，所以這是「降低」而不是「擋死」。
 *     要完全擋死需要外部儲存（Redis／資料庫），對本專案不值得；文件要誠實寫清楚。
 *   - 桶子有上限（MAX_BUCKETS），而且會清掉過期的：不能讓攻擊者用大量不同 IP 把記憶體塞爆。
 *   - 一律回傳布林值，呼叫端自己決定要回 429 還是靜默丟掉。
 */
const MAX_BUCKETS = 5000;

function createThrottle(options = {}) {
    const now = options.now || (() => Date.now());
    const buckets = new Map();

    function prune(current) {
        for (const [key, bucket] of buckets) {
            if (bucket.resetAt <= current) buckets.delete(key);
        }
    }

    /* key 建議用 `${ip}|${bucketName}`；回傳 true 代表「這次可以」。 */
    function allow(key, limit, windowMs) {
        const current = now();
        if (buckets.size > MAX_BUCKETS) prune(current);
        const name = String(key);
        let bucket = buckets.get(name);
        if (!bucket || bucket.resetAt <= current) {
            bucket = { count: 0, resetAt: current + windowMs };
            buckets.set(name, bucket);
        }
        bucket.count += 1;
        if (bucket.count > limit) {
            return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, bucket.resetAt - current) };
        }
        return { allowed: true, remaining: Math.max(0, limit - bucket.count), retryAfterMs: 0 };
    }

    function size() {
        return buckets.size;
    }

    function clear() {
        buckets.clear();
    }

    return { allow, size, clear };
}

module.exports = { createThrottle, MAX_BUCKETS };

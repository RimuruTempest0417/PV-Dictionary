/* 整單元連續播放（B-2）
 *
 * 為什麼要一支單獨的模組：
 *   1. 播放順序與「哪一張正在播」的狀態要能測（tests/playlist.test.js 用假的播放器驗），
 *      不能跟畫面綁死。
 *   2. 中途停止一定要同時停掉兩種播放（老師錄音的 <audio> 與瀏覽器語音），
 *      少停一種就會出現「按了停止還在念」。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;   /* Node（測試用） */
    if (root) root.PDPlaylist = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    /* play(entries, options)
     *   entries：生字陣列（依顯示順序）
     *   options.playEntry(entry) → Promise（預設用 PDAudio.playEntry）
     *   options.onChange(entry, index, total) → 目前播到哪一個（畫面用來highlight）
     *   options.onDone(reason) → 'done' | 'stopped' | 'empty'
     *   options.gapMs → 每個生字之間停一下（預設 350ms，讓耳朵跟得上）
     * 回傳 { stop() }
     */
    function create(options = {}) {
        const state = { stopped: false, running: false, index: -1 };
        const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

        async function run(entries) {
            const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
            state.stopped = false;
            state.running = true;
            if (!list.length) {
                state.running = false;
                if (options.onDone) options.onDone('empty');
                return 'empty';
            }
            const playEntry = options.playEntry || ((entry) => window.PDAudio.playEntry(entry));
            const gapMs = options.gapMs === undefined ? 350 : Number(options.gapMs);
            for (let index = 0; index < list.length; index += 1) {
                if (state.stopped) break;
                state.index = index;
                if (options.onChange) options.onChange(list[index], index, list.length);
                try {
                    await playEntry(list[index]);
                } catch (err) {
                    /* 單一個生字播不出來（例如裝置沒有語音）不該讓整輪停掉，繼續下一個 */
                }
                if (state.stopped) break;
                if (gapMs) await sleep(gapMs);
            }
            const reason = state.stopped ? 'stopped' : 'done';
            state.running = false;
            state.index = -1;
            if (options.onDone) options.onDone(reason);
            return reason;
        }

        function stop() {
            state.stopped = true;
            state.running = false;
            state.index = -1;
            if (options.onStop) options.onStop();
        }

        return { run, stop, state };
    }

    return { create };
}));

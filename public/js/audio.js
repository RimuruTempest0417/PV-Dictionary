/* 讀音播放
 *
 * 優先序（與說明一致）：該生字有老師錄音 → 播錄音；沒有 → 用瀏覽器語音合成（TTS）。
 * 使用者在 UI 上看到的都是同一顆 🔊。
 *
 * 誠實限制（介面上也有寫）：
 * - TTS 的聲音取決於裝置與瀏覽器（iOS／Android／桌機不同），不是「字典的標準發音」。
 * - iOS Safari 必須在使用者手勢中播放（點 🔊 就是手勢，所以可行）。
 * - 瀏覽器不支援語音合成時，按鈕會停用並提示改用老師錄音。
 */
(function () {
    const state = {
        accent: 'en-GB',
        lastSpoken: null,
        playingId: null,
        playingAudio: null
    };

    function ttsSupported() {
        return typeof window.speechSynthesis !== 'undefined'
            && typeof window.SpeechSynthesisUtterance !== 'undefined';
    }

    const t = (key, vars) => window.PDI18n.t(key, vars);

    function availableVoices() {
        if (!ttsSupported()) return [];
        try {
            return window.speechSynthesis.getVoices() || [];
        } catch (err) {
            return [];
        }
    }

    function pickVoice(accent) {
        const voices = availableVoices();
        if (!voices.length) return null;
        const want = String(accent).replace('_', '-').toLowerCase();
        const exact = voices.find((v) => String(v.lang || '').replace('_', '-').toLowerCase() === want);
        if (exact) return exact;
        const prefix = want.slice(0, 2);
        return voices.find((v) => String(v.lang || '').toLowerCase().startsWith(prefix)) || null;
    }

    /* 回傳 Promise；呼叫端負責處理失敗（例如顯示「請改用老師錄音」） */
    function speak(text, options) {
        const opts = options || {};
        if (!ttsSupported()) {
            return Promise.reject(new Error(t('speak.unsupported')));
        }
        return new Promise((resolve, reject) => {
            try {
                window.speechSynthesis.cancel();
                const utterance = new window.SpeechSynthesisUtterance(String(text));
                utterance.lang = opts.accent || state.accent;
                const voice = pickVoice(utterance.lang);
                if (voice) utterance.voice = voice;
                utterance.rate = typeof opts.rate === 'number' ? opts.rate : 0.9;
                utterance.pitch = 1;
                utterance.onend = () => resolve(true);
                utterance.onerror = () => reject(new Error(t('speak.failed')));
                // 檢查腳本（與未來的自動化）要能確認「真的呼叫了語音合成」
                state.lastSpoken = { text: String(text), lang: utterance.lang, at: Date.now() };
                window.speechSynthesis.speak(utterance);
                // 部分瀏覽器（尤其行動版）不會回報 onend，保險起見仍讓流程往前走
                window.setTimeout(() => resolve(true), Math.min(8000, 1200 + String(text).length * 140));
            } catch (err) {
                reject(err);
            }
        });
    }

    function stopTts() {
        if (ttsSupported()) {
            try {
                window.speechSynthesis.cancel();
            } catch (err) {
                /* 忽略 */
            }
        }
    }

    /* 播一個音檔。★ 一定把 Audio 存進 state：連續播放（B-2）要能中途停下來，
     *   不然按了「停止」之後，已經在播的那一個還是會繼續念。 */
    function playUrl(url, options) {
        return new Promise((resolve, reject) => {
            stopAudio();
            const audio = new Audio(url);
            state.playingAudio = audio;
            audio.onended = () => {
                if (state.playingAudio === audio) state.playingAudio = null;
                resolve(true);
            };
            audio.onerror = () => {
                if (state.playingAudio === audio) state.playingAudio = null;
                reject(new Error(t('speak.failed')));
            };
            audio.play().then(() => undefined).catch((err) => reject(err));
            if (options && options.onStart) options.onStart();
        });
    }

    /* 停掉正在播的音檔（沒有播就什麼都不做） */
    function stopAudio() {
        const audio = state.playingAudio;
        state.playingAudio = null;
        if (!audio) return false;
        try {
            audio.pause();
            audio.currentTime = 0;
        } catch (err) {
            /* 忽略 */
        }
        return true;
    }

    /* entry：/api/units/:id 回傳的生字物件（has_audio / audio_id） */
    function playEntry(entry) {
        if (!entry) return Promise.reject(new Error(t('errors.ENTRY_NOT_FOUND')));
        if (entry.has_audio && entry.audio_id) {
            return playUrl(`/api/audio/${entry.audio_id}`);
        }
        return speak(entry.headword);
    }

    window.PDAudio = {
        ttsSupported,
        availableVoices,
        speak,
        stopTts,
        stopAudio,
        playUrl,
        playEntry,
        state,
        get lastSpoken() {
            return state.lastSpoken;
        }
    };
})();

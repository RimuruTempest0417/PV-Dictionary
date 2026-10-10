/* 生字清單的呈現與過濾
 * 只負責「畫出來」與「過濾」；資料的讀寫在 app.js／admin.js。
 * v0.13.0（F-5）：多了「我的清單」——存在**自己的瀏覽器**（localStorage），不用帳號。
 */
(function () {
    const { el, clear } = window.PDUI;
    const t = (key, vars) => window.PDI18n.t(key, vars);

    /* ---------------- 我的清單（F-5，學生端） ----------------
     * 為什麼存在瀏覽器：學生沒有帳號（也不用登入就能查生字），所以「我收藏的字」只存在他自己的裝置。
     * 換裝置或清掉瀏覽器資料就會不見 —— 這是刻意的取捨（站內說明有寫）。
     * 無痕模式可能禁止 localStorage：一律用 try/catch，壞掉時功能失效但網站照常運作。 */
    const MY_LIST_KEY = 'pd.myList';

    function loadMyList() {
        try {
            const raw = window.localStorage.getItem(MY_LIST_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(parsed) ? parsed.map((id) => String(id)) : []);
        } catch (error) {
            return new Set();
        }
    }

    let myList = loadMyList();

    function saveMyList() {
        try {
            window.localStorage.setItem(MY_LIST_KEY, JSON.stringify([...myList]));
        } catch (error) { /* 無痕模式／配額滿：功能失效，但不要讓網站壞掉 */ }
    }

    function myListIds() { return [...myList]; }
    function myListHas(id) { return myList.has(String(id)); }
    function myListCount() { return myList.size; }

    function myListToggle(id) {
        const key = String(id);
        if (myList.has(key)) myList.delete(key);
        else myList.add(key);
        saveMyList();
        /* app.js 聽這個事件：如果正開著「我的清單」篩選，取消收藏就要把那一列拿掉 */
        window.dispatchEvent(new CustomEvent('pd:mylist', { detail: { id: key, count: myList.size, on: myList.has(key) } }));
        return myList.has(key);
    }

    function myListClear() {
        myList = new Set();
        saveMyList();
        window.dispatchEvent(new CustomEvent('pd:mylist', { detail: { id: null, count: 0, on: false } }));
    }

    /* 審核狀態的文字隨語言變化，所以用函式而不是常數表 */
    function statusLabel(status) {
        if (status === 'pending') return t('status.pending');
        if (status === 'rejected') return t('status.rejected');
        if (status === 'draft') return t('status.draft');
        return '';
    }

    function statusClass(status) {
        if (status === 'pending') return 'tag-badge is-pending';
        if (status === 'rejected') return 'tag-badge is-rejected';
        return 'tag-badge';
    }

    /* 搜尋：生字、中文、英文解釋、音標、詞性都比對（大小寫不敏感） */
    function filterEntries(entries, query) {
        const key = String(query || '').trim().toLowerCase();
        if (!key) return entries.slice();
        return entries.filter((entry) => [
            entry.headword,
            entry.zh_meaning,
            entry.en_definition,
            entry.ipa_us,
            entry.ipa_uk,
            entry.part_of_speech,
            entry.example_en,
            entry.example_zh
        ].some((value) => String(value || '').toLowerCase().includes(key)));
    }

    function starButton(entry, starred) {
        const on = starred(entry.id);
        return el('button', {
            class: `star-btn${on ? ' is-on' : ''}`,
            text: on ? '★' : '☆',
            attrs: {
                type: 'button',
                'data-action': 'star-entry',
                'data-entry-id': entry.id,
                'aria-pressed': on ? 'true' : 'false',
                'aria-label': t('myList.toggle', { word: entry.headword }),
                title: t('myList.toggle', { word: entry.headword })
            }
        });
    }

    function entryCard(entry, options) {
        const opts = options || {};
        const starred = opts.starred || myListHas;
        const speakBtn = el('button', {
            class: 'speak-btn',
            text: '🔊',
            attrs: {
                type: 'button',
                title: entry.has_audio ? t('speak.teacherTitle') : t('speak.ttsTitle'),
                'aria-label': t('speak.play', { word: entry.headword }),
                'data-action': 'speak',
                'data-entry-id': entry.id
            }
        });
        if (!entry.has_audio && !window.PDAudio.ttsSupported()) {
            speakBtn.disabled = true;
            speakBtn.title = t('speak.unsupported');
        }

        const headline = el('div', { class: 'vocab-headline' }, [
            el('span', { class: 'headword', text: entry.headword }),
            entry.ipa_us ? el('span', { class: 'ipa', text: entry.ipa_us, attrs: { title: `US · ${entry.ipa_us}` } }) : null,
            entry.ipa_uk ? el('span', { class: 'ipa', text: `UK ${entry.ipa_uk}`, attrs: { title: `UK · ${entry.ipa_uk}` } }) : null,
            entry.part_of_speech ? el('span', { class: 'pos-badge', text: entry.part_of_speech }) : null,
            entry.has_audio ? el('span', { class: 'tag-badge', text: t('badge.teacherAudio') }) : null,
            /* 沒有老師錄音的生字要說清楚「這個聲音是電腦唸的」（B-2 的誠實原則），
             * 也順便讓老師一眼看出哪些還沒錄。 */
            !entry.has_audio ? el('span', { class: 'tag-badge tag-badge-muted', text: t('badge.tts'), attrs: { title: t('badge.ttsHint') } }) : null,
            entry.status && entry.status !== 'published'
                ? el('span', { class: statusClass(entry.status), text: statusLabel(entry.status) })
                : null
        ]);

        const main = el('div', { class: 'vocab-main' }, [
            headline,
            entry.zh_meaning ? el('p', { class: 'meaning-zh', text: entry.zh_meaning }) : null,
            entry.en_definition ? el('p', { class: 'meaning-en', text: entry.en_definition }) : null,
            /* 被退回的生字要把原因顯示出來（科代表才知道要改什麼，B-6） */
            entry.status === 'rejected' && entry.review_note
                ? el('p', { class: 'review-note', text: t('entry.rejectedReason', { note: entry.review_note }) })
                : null,
            (entry.example_en || entry.example_zh) ? el('div', { class: 'example' }, [
                entry.example_en ? el('span', { class: 'example-en', text: entry.example_en }) : null,
                entry.example_zh ? el('span', { class: 'example-zh', text: entry.example_zh }) : null
            ]) : null
        ]);

        const actions = [];
        /* 已發佈的生字只有能發佈的人（老師以上）能改／刪 —— 後端就是這樣判斷的，
         * 所以前端也不要顯示按鈕，否則會變成「看得到按鈕、按下去被拒」（C-2 的一致性）。 */
        const lockedPublished = entry.status === 'published' && opts.canEdit && !opts.canPublish;
        if (lockedPublished) {
            actions.push(el('span', { class: 'tag-badge', text: t('entry.publishedLocked'), attrs: { title: t('entry.publishedLockedHint') } }));
        }
        if (opts.canEdit && !lockedPublished) {
            actions.push(el('button', {
                class: 'btn btn-secondary btn-small',
                text: t('action.edit'),
                attrs: { type: 'button', 'data-action': 'edit-entry', 'data-entry-id': entry.id }
            }));
            actions.push(el('button', {
                class: 'btn btn-danger btn-small',
                text: t('action.delete'),
                attrs: { type: 'button', 'data-action': 'delete-entry', 'data-entry-id': entry.id }
            }));
        }
        if (opts.canUploadAudio) {
            actions.push(el('button', {
                class: 'btn btn-ghost btn-small',
                text: entry.has_audio ? t('action.replaceRecord') : t('action.record'),
                attrs: { type: 'button', 'data-action': 'upload-audio', 'data-entry-id': entry.id }
            }));
        }

        const children = [speakBtn, main];
        if (actions.length) children.push(el('div', { class: 'vocab-actions' }, actions));
        /* ★ 在最外層（不放在 .vocab-actions：那是老師的編輯區，列印與窄螢幕都會被隱藏／擠掉） */
        return el('li', { class: 'vocab-item', dataset: { entryId: entry.id } },
            [starButton(entry, starred)].concat(children));
    }

    /* entries 已由呼叫端過濾；這裡只負責排序（已發佈在前、待審核在後） */
    function sortForDisplay(entries) {
        const weight = (entry) => {
            if (entry.status === 'pending') return 2;
            if (entry.status === 'rejected') return 3;
            return entry.status && entry.status !== 'published' ? 4 : 1;
        };
        return entries.slice().sort((a, b) => (weight(a) - weight(b))
            || ((a.sort_order || 0) - (b.sort_order || 0))
            || (a.id - b.id));
    }

    /* 字母順序（B-9）：列印學習單用。生字不分大小寫、同字再照 id。 */
    function sortAlphabetical(entries) {
        return entries.slice().sort((a, b) => {
            const left = String(a.headword || '').toLowerCase();
            const right = String(b.headword || '').toLowerCase();
            if (left !== right) return left < right ? -1 : 1;
            return (a.id || 0) - (b.id || 0);
        });
    }

    function render(entries, options) {
        const opts = options || {};
        const list = document.getElementById('vocabList');
        const empty = document.getElementById('vocabEmpty');
        if (!list) return { shown: 0, total: 0 };
        clear(list);
        const filtered = filterEntries(entries, opts.query);
        const rows = opts.alphabetical ? sortAlphabetical(filtered) : sortForDisplay(filtered);
        for (const entry of rows) list.appendChild(entryCard(entry, opts));
        if (empty) {
            empty.hidden = rows.length > 0;
            empty.textContent = rows.length === 0 && (opts.total || 0) > 0
                ? t('unit.noMatch')
                : (opts.emptyText || t('unit.empty'));
        }
        return { shown: rows.length, total: (opts.total !== undefined ? opts.total : entries.length) };
    }

    /* 只更新某一顆 ★（不重畫整份清單，捲動位置才不會跳掉） */
    function refreshStar(entryId) {
        const on = myListHas(entryId);
        document.querySelectorAll(`.star-btn[data-entry-id="${entryId}"]`).forEach((button) => {
            button.textContent = on ? '★' : '☆';
            button.classList.toggle('is-on', on);
            button.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    /* 播放一顆 🔊：正確反映「有老師錄音 / 用 TTS」兩種來源 */
    async function speakEntry(entryId, button) {
        const entry = (window.PDState.entries || []).find((e) => String(e.id) === String(entryId));
        if (!entry) return;
        const buttons = document.querySelectorAll(`.speak-btn[data-entry-id="${entryId}"]`);
        const mark = (on) => {
            buttons.forEach((btn) => {
                btn.classList.toggle('is-playing', on);
                btn.textContent = on ? '🔈' : '🔊';
            });
            const card = button ? button.closest('.vocab-item') : null;
            if (card) card.classList.toggle('is-playing', on);
        };
        try {
            mark(true);
            await window.PDAudio.playEntry(entry);
            window.PDUI.toast(entry.has_audio
                ? t('speak.teacherToast', { word: entry.headword })
                : t('speak.ttsToast', { word: entry.headword }));
        } catch (err) {
            window.PDUI.toast(window.PDI18n.errorMessage(err), 'error');
        } finally {
            mark(false);
        }
    }

    window.PDVocab = {
        render, filterEntries, sortForDisplay, sortAlphabetical, speakEntry, statusLabel, refreshStar,
        /* F-5：我的清單 */
        myList: { ids: myListIds, has: myListHas, count: myListCount, toggle: myListToggle, clear: myListClear }
    };
})();

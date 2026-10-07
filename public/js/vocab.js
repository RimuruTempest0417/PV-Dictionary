/* 生字清單的呈現與過濾
 * 只負責「畫出來」與「過濾」；資料的讀寫在 app.js／admin.js。
 */
(function () {
    const { el, clear } = window.PDUI;

    const STATUS_LABEL = {
        published: '',
        pending: '⏳ 待審核',
        draft: '草稿',
        rejected: '↩️ 已退回'
    };

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

    function entryCard(entry, options) {
        const opts = options || {};
        const speakBtn = el('button', {
            class: 'speak-btn',
            text: '🔊',
            attrs: {
                type: 'button',
                title: entry.has_audio ? '播放老師錄音' : '用瀏覽器語音合成播放讀音',
                'aria-label': `播放 ${entry.headword} 的讀音`,
                'data-action': 'speak',
                'data-entry-id': entry.id
            }
        });
        if (!entry.has_audio && !window.PDAudio.ttsSupported()) {
            speakBtn.disabled = true;
            speakBtn.title = '這個瀏覽器不支援語音合成，請改用老師錄音';
        }

        const headline = el('div', { class: 'vocab-headline' }, [
            el('span', { class: 'headword', text: entry.headword }),
            entry.ipa_us ? el('span', { class: 'ipa', text: entry.ipa_us, attrs: { title: '美式讀音（IPA）' } }) : null,
            entry.ipa_uk ? el('span', { class: 'ipa', text: `英 ${entry.ipa_uk}`, attrs: { title: '英式讀音（IPA）' } }) : null,
            entry.part_of_speech ? el('span', { class: 'pos-badge', text: entry.part_of_speech }) : null,
            entry.has_audio ? el('span', { class: 'tag-badge', text: '👩‍🏫 老師錄音' }) : null,
            entry.status && entry.status !== 'published'
                ? el('span', { class: statusClass(entry.status), text: STATUS_LABEL[entry.status] || entry.status })
                : null
        ]);

        const main = el('div', { class: 'vocab-main' }, [
            headline,
            entry.zh_meaning ? el('p', { class: 'meaning-zh', text: entry.zh_meaning }) : null,
            entry.en_definition ? el('p', { class: 'meaning-en', text: entry.en_definition }) : null,
            (entry.example_en || entry.example_zh) ? el('div', { class: 'example' }, [
                entry.example_en ? el('span', { class: 'example-en', text: entry.example_en }) : null,
                entry.example_zh ? el('span', { class: 'example-zh', text: entry.example_zh }) : null
            ]) : null
        ]);

        const actions = [];
        if (opts.canEdit) {
            actions.push(el('button', {
                class: 'btn btn-secondary btn-small',
                text: '✏️ 編輯',
                attrs: { type: 'button', 'data-action': 'edit-entry', 'data-entry-id': entry.id }
            }));
            actions.push(el('button', {
                class: 'btn btn-danger btn-small',
                text: '🗑 刪除',
                attrs: { type: 'button', 'data-action': 'delete-entry', 'data-entry-id': entry.id }
            }));
        }
        if (opts.canUploadAudio) {
            actions.push(el('button', {
                class: 'btn btn-ghost btn-small',
                text: entry.has_audio ? '🎙 換錄音' : '🎙 錄音 / 上傳',
                attrs: { type: 'button', 'data-action': 'upload-audio', 'data-entry-id': entry.id }
            }));
        }

        const children = [speakBtn, main];
        if (actions.length) children.push(el('div', { class: 'vocab-actions' }, actions));
        return el('li', { class: 'vocab-item', dataset: { entryId: entry.id } }, children);
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

    function render(entries, options) {
        const opts = options || {};
        const list = document.getElementById('vocabList');
        const empty = document.getElementById('vocabEmpty');
        if (!list) return { shown: 0, total: 0 };
        clear(list);
        const rows = sortForDisplay(filterEntries(entries, opts.query));
        for (const entry of rows) list.appendChild(entryCard(entry, opts));
        if (empty) {
            empty.hidden = rows.length > 0;
            if (rows.length === 0 && (opts.total || 0) > 0) {
                empty.textContent = '沒有符合搜尋條件的生字。';
            } else {
                empty.textContent = '這個單元還沒有生字。';
            }
        }
        return { shown: rows.length, total: (opts.total !== undefined ? opts.total : entries.length) };
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
            window.PDUI.toast(entry.has_audio ? `播放老師錄音：${entry.headword}` : `語音合成：${entry.headword}`);
        } catch (err) {
            window.PDUI.toast(err.message || '播放失敗', 'error');
        } finally {
            mark(false);
        }
    }

    window.PDVocab = { render, filterEntries, sortForDisplay, speakEntry, STATUS_LABEL };
})();

/* 管理功能（老師以上；科代表可新增但進待審核）
 * 全部走自家 API；權限一律由後端重新驗證，前端只是「不顯示你不能用的按鈕」。
 */
(function () {
    const { el, clear, toast, setFormMessage, formatDateTime } = window.PDUI;
    const api = window.PDApi;

    const state = {
        editingId: null,
        audioEntryId: null,
        recorder: null,
        recordedChunks: [],
        recordTimer: null
    };

    /* ---------------- 生字表單 ---------------- */
    function showPanel(formId, show) {
        const node = document.getElementById(formId);
        if (node) node.hidden = !show;
    }

    function fillEntryForm(entry) {
        document.getElementById('entryId').value = entry ? entry.id : '';
        document.getElementById('fHeadword').value = entry ? entry.headword : '';
        document.getElementById('fPos').value = entry ? (entry.part_of_speech || '') : '';
        document.getElementById('fIpaUs').value = entry ? (entry.ipa_us || '') : '';
        document.getElementById('fIpaUk').value = entry ? (entry.ipa_uk || '') : '';
        document.getElementById('fZh').value = entry ? (entry.zh_meaning || '') : '';
        document.getElementById('fEn').value = entry ? (entry.en_definition || '') : '';
        document.getElementById('fExampleEn').value = entry ? (entry.example_en || '') : '';
        document.getElementById('fExampleZh').value = entry ? (entry.example_zh || '') : '';
    }

    function openEntryForm(entry) {
        state.editingId = entry ? entry.id : null;
        fillEntryForm(entry || null);
        document.getElementById('entryFormTitle').textContent = entry ? `✏️ 修改生字：${entry.headword}` : '➕ 新增生字';
        document.getElementById('entryFormNote').textContent = entry
            ? '修改後按「儲存」立即生效。'
            : '填好後按「儲存」，會立即加到這個單元。';
        setFormMessage(document.getElementById('entryFormMsg'), '');
        showPanel('entryForm', true);
        showPanel('importForm', false);
        showPanel('unitForm', false);
        showPanel('bookForm', false);
        document.getElementById('fHeadword').focus();
    }

    function closeEntryForm() {
        state.editingId = null;
        showPanel('entryForm', false);
        setFormMessage(document.getElementById('entryFormMsg'), '');
    }

    async function submitEntry(event) {
        event.preventDefault();
        const msg = document.getElementById('entryFormMsg');
        const unitId = window.PDState.currentUnitId;
        if (!unitId) return;
        const payload = {
            headword: document.getElementById('fHeadword').value,
            part_of_speech: document.getElementById('fPos').value,
            ipa_us: document.getElementById('fIpaUs').value,
            ipa_uk: document.getElementById('fIpaUk').value,
            zh_meaning: document.getElementById('fZh').value,
            en_definition: document.getElementById('fEn').value,
            example_en: document.getElementById('fExampleEn').value,
            example_zh: document.getElementById('fExampleZh').value
        };
        const button = document.getElementById('saveEntryBtn');
        button.disabled = true;
        try {
            if (state.editingId) {
                await api.patch(`/api/entries/${state.editingId}`, payload);
                setFormMessage(msg, '已儲存修改。', 'ok');
                toast('已更新生字');
            } else {
                const result = await api.post(`/api/units/${unitId}/entries`, payload);
                setFormMessage(msg, result.status === 'pending'
                    ? '已送出，等老師核准後學生才看得到。'
                    : '已新增到這個單元。', 'ok');
                toast(result.status === 'pending' ? '已送出待審核' : '已新增生字');
            }
            await window.PDApp.reloadUnit({ keepForm: true });
            if (!state.editingId) fillEntryForm(null);
        } catch (err) {
            setFormMessage(msg, err.message, 'error');
        } finally {
            button.disabled = false;
        }
    }

    /* ---------------- 批次貼上 ---------------- */
    function openImport() {
        setFormMessage(document.getElementById('importMsg'), '');
        showPanel('importForm', true);
        showPanel('entryForm', false);
        showPanel('unitForm', false);
        showPanel('bookForm', false);
        document.getElementById('importText').focus();
    }

    async function submitImport(event) {
        event.preventDefault();
        const msg = document.getElementById('importMsg');
        const unitId = window.PDState.currentUnitId;
        if (!unitId) return;
        const text = document.getElementById('importText').value;
        const button = document.getElementById('importBtn');
        button.disabled = true;
        try {
            const result = await api.post(`/api/units/${unitId}/entries/import`, { text });
            const parts = [`新增 ${result.created} 筆`];
            if (result.skipped) parts.push(`略過 ${result.skipped} 筆（重複或空白）`);
            if (result.errors && result.errors.length) parts.push(`${result.errors.length} 行格式有問題`);
            if (result.status === 'pending') parts.push('狀態：待審核');
            setFormMessage(msg, parts.join('，'), result.created ? 'ok' : 'error');
            document.getElementById('importText').value = '';
            await window.PDApp.reloadUnit({ keepForm: true });
        } catch (err) {
            setFormMessage(msg, err.message, 'error');
        } finally {
            button.disabled = false;
        }
    }

    /* ---------------- 新增單元／書本 ---------------- */
    async function submitUnit(event) {
        event.preventDefault();
        const msg = document.getElementById('unitMsg');
        const bookId = window.PDState.currentBookId;
        if (!bookId) return;
        try {
            const unitNo = Number(document.getElementById('fUnitNo').value);
            const title = document.getElementById('fUnitTitle').value;
            const result = await api.post(`/api/books/${bookId}/units`, { unit_no: unitNo, title });
            setFormMessage(msg, `已建立 Unit ${result.unit.unit_no}`, 'ok');
            toast('已建立單元');
            document.getElementById('fUnitTitle').value = '';
            showPanel('unitForm', false);
            await window.PDApp.reloadBooks();
            await window.PDApp.selectUnit(result.unit.id);
        } catch (err) {
            setFormMessage(msg, err.message, 'error');
        }
    }

    async function submitBook(event) {
        event.preventDefault();
        const msg = document.getElementById('bookMsg');
        try {
            const result = await api.post('/api/books', {
                code: document.getElementById('fBookCode').value,
                name: document.getElementById('fBookName').value,
                grade: document.getElementById('fBookGrade').value
            });
            setFormMessage(msg, `已建立 ${result.book.name}`, 'ok');
            toast('已建立書本');
            document.getElementById('fBookCode').value = '';
            document.getElementById('fBookName').value = '';
            document.getElementById('fBookGrade').value = '';
            showPanel('bookForm', false);
            await window.PDApp.reloadBooks();
            await window.PDApp.selectBook(result.book.id);
        } catch (err) {
            setFormMessage(msg, err.message, 'error');
        }
    }

    /* ---------------- 刪除生字（兩段式確認，不用原生 confirm） ---------------- */
    async function deleteEntry(entryId, button) {
        const entry = (window.PDState.entries || []).find((e) => String(e.id) === String(entryId));
        if (!entry) return;
        if (button && button.dataset.confirm !== '1') {
            button.dataset.confirm = '1';
            button.textContent = '🗑 再按一次確認';
            window.setTimeout(() => {
                button.dataset.confirm = '';
                button.textContent = '🗑 刪除';
            }, 4000);
            return;
        }
        try {
            await api.del(`/api/entries/${entryId}`);
            toast(`已刪除 ${entry.headword}`);
            await window.PDApp.reloadUnit();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /* ---------------- 待審核 ---------------- */
    function renderPending(entries) {
        const block = document.getElementById('pendingBlock');
        const list = document.getElementById('pendingList');
        const count = document.getElementById('pendingCount');
        const note = document.getElementById('pendingNote');
        const pending = (entries || []).filter((entry) => entry.status === 'pending');
        const canReview = window.PDAuth.atLeast('teacher');
        const canEdit = window.PDAuth.can('can_edit');
        clear(list);
        count.textContent = String(pending.length);
        // 老師看得到整份待審核清單；科代表要看得到自己剛送出的字（不然介面等於在騙人）
        block.hidden = !(canEdit && pending.length > 0);
        note.textContent = canReview
            ? '科代表新增的生字，需要老師核准才會出現在學生的生字表。'
            : '你送出的生字正在等老師核准；核准後學生才看得到。';
        for (const entry of pending) {
            const info = el('div', { class: 'pending-item-info' }, [
                el('strong', { text: entry.headword }),
                el('span', { text: [entry.ipa_us, entry.part_of_speech, entry.zh_meaning].filter(Boolean).join(' · ') }),
                el('span', { class: 'unit-meta', text: `由 ${entry.created_by || '未知'} 新增於 ${formatDateTime(entry.created_at)}` })
            ]);
            const actions = canReview ? el('div', { class: 'pending-item-actions' }, [
                el('button', {
                    class: 'btn btn-primary btn-small',
                    text: '✅ 核准',
                    attrs: { type: 'button', 'data-action': 'approve-entry', 'data-entry-id': entry.id }
                }),
                el('button', {
                    class: 'btn btn-ghost btn-small',
                    text: '↩️ 退回',
                    attrs: { type: 'button', 'data-action': 'reject-entry', 'data-entry-id': entry.id }
                })
            ]) : null;
            list.appendChild(el('li', { class: 'pending-item' }, [info, actions]));
        }
    }

    async function review(entryId, action) {
        try {
            await api.post(`/api/entries/${entryId}/review`, { action });
            toast(action === 'approve' ? '已核准，學生現在看得到了' : '已退回');
            await window.PDApp.reloadUnit();
            await PDAdmin.loadAudit();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    /* ---------------- 稽核紀錄 ---------------- */
    async function loadAudit() {
        const block = document.getElementById('auditBlock');
        const list = document.getElementById('auditList');
        if (!block || block.hidden || !window.PDAuth.can('can_view_audit')) return;
        try {
            const data = await api.get('/api/admin/audit-logs?limit=12');
            clear(list);
            if (!data.logs.length) {
                list.appendChild(el('li', { class: 'audit-item', text: '目前沒有紀錄。' }));
                return;
            }
            for (const row of data.logs) {
                list.appendChild(el('li', { class: 'audit-item' }, [
                    el('span', { class: 'audit-when', text: formatDateTime(row.created_at) }),
                    el('span', { text: `${row.action_label}｜${row.details || row.target_id || ''}` }),
                    el('span', { class: 'audit-who', text: row.display_name || row.user_id || '' })
                ]));
            }
        } catch (err) {
            clear(list);
            list.appendChild(el('li', { class: 'audit-item', text: `讀取失敗：${err.message}` }));
        }
    }

    /* ---------------- 老師錄音（上傳檔案或直接用麥克風錄） ---------------- */
    function openAudioModal(entryId) {
        const entry = (window.PDState.entries || []).find((e) => String(e.id) === String(entryId));
        if (!entry) return;
        state.audioEntryId = entry.id;
        document.getElementById('audioModalHeadword').textContent = entry.headword;
        setFormMessage(document.getElementById('audioMsg'), entry.has_audio
            ? '這個生字已經有老師錄音，重新上傳會取代舊的。'
            : '可以上傳現成的音檔，或直接用麥克風錄一段（建議 30 秒內）。');
        const del = document.getElementById('audioDeleteBtn');
        del.hidden = !entry.has_audio;
        document.getElementById('audioStopBtn').hidden = true;
        document.getElementById('audioRecordBtn').disabled = false;
        document.getElementById('audioModal').hidden = false;
    }

    function closeAudioModal() {
        stopRecording();
        state.audioEntryId = null;
        document.getElementById('audioModal').hidden = true;
        setFormMessage(document.getElementById('audioMsg'), '');
    }

    async function uploadAudio(dataUrl, mime, durationMs) {
        const entryId = state.audioEntryId;
        if (!entryId) return;
        setFormMessage(document.getElementById('audioMsg'), '上傳中…');
        try {
            await api.post(`/api/entries/${entryId}/audio`, {
                data: dataUrl,
                mime,
                duration_ms: durationMs || 0
            });
            setFormMessage(document.getElementById('audioMsg'), '已儲存，現在 🔊 會播放這段錄音。', 'ok');
            toast('已儲存老師錄音');
            await window.PDApp.reloadUnit();
            window.setTimeout(closeAudioModal, 900);
        } catch (err) {
            setFormMessage(document.getElementById('audioMsg'), err.message, 'error');
        }
    }

    /* 檔案輸入元件固定在 HTML 裡（id=audioFileInput），按鈕只是去點它。
     * 這樣真實瀏覽器與自動化檢查都能沿著同一條路徑走（不必各自造一份）。 */
    function onAudioFileChosen() {
        const input = document.getElementById('audioFileInput');
        const file = input.files && input.files[0];
        if (!file) return;
        if (file.size > 1024 * 1024) {
            setFormMessage(document.getElementById('audioMsg'), `檔案太大（${Math.round(file.size / 1024)}KB），上限 1MB`, 'error');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => uploadAudio(String(reader.result), file.type || 'audio/mpeg', 0);
        reader.onerror = () => setFormMessage(document.getElementById('audioMsg'), '讀取檔案失敗', 'error');
        reader.readAsDataURL(file);
    }

    function pickAudioFile() {
        const input = document.getElementById('audioFileInput');
        input.value = '';
        input.click();
    }

    function stopRecording() {
        if (state.recordTimer) {
            window.clearInterval(state.recordTimer);
            state.recordTimer = null;
        }
        if (state.recorder && state.recorder.state !== 'inactive') {
            try {
                state.recorder.stop();
            } catch (err) {
                /* 已經停止 */
            }
        }
        state.recorder = null;
    }

    async function startRecording() {
        const msg = document.getElementById('audioMsg');
        if (!navigator.mediaDevices || !window.MediaRecorder) {
            setFormMessage(msg, '這個瀏覽器不支援錄音，請改用「選擇檔案」。', 'error');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((type) => {
                try {
                    return window.MediaRecorder.isTypeSupported(type);
                } catch (err) {
                    return false;
                }
            }) || '';
            const recorder = mime ? new window.MediaRecorder(stream, { mimeType: mime }) : new window.MediaRecorder(stream);
            state.recordedChunks = [];
            const startedAt = Date.now();
            recorder.addEventListener('dataavailable', (event) => {
                if (event.data && event.data.size) state.recordedChunks.push(event.data);
            });
            recorder.addEventListener('stop', () => {
                stream.getTracks().forEach((track) => track.stop());
                const blob = new Blob(state.recordedChunks, { type: recorder.mimeType || 'audio/webm' });
                if (!blob.size) {
                    setFormMessage(msg, '沒有錄到聲音，再試一次。', 'error');
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => uploadAudio(String(reader.result), blob.type || 'audio/webm', Date.now() - startedAt);
                reader.readAsDataURL(blob);
            });
            state.recorder = recorder;
            recorder.start();
            document.getElementById('audioRecordBtn').disabled = true;
            document.getElementById('audioStopBtn').hidden = false;
            setFormMessage(msg, '錄音中…按「停止並儲存」結束。');
            state.recordTimer = window.setInterval(() => {
                const seconds = Math.round((Date.now() - startedAt) / 1000);
                setFormMessage(msg, `錄音中… ${seconds} 秒（上限 60 秒）`);
                if (seconds >= 60) stopRecording();
            }, 500);
        } catch (err) {
            setFormMessage(msg, `無法使用麥克風：${err.message}`, 'error');
        }
    }

    async function deleteTeacherAudio() {
        const entryId = state.audioEntryId;
        const entry = (window.PDState.entries || []).find((e) => String(e.id) === String(entryId));
        if (!entry || !entry.audio_id) return;
        try {
            await api.del(`/api/audio/${entry.audio_id}`);
            toast('已刪除老師錄音，之後會用語音合成');
            await window.PDApp.reloadUnit();
            closeAudioModal();
        } catch (err) {
            setFormMessage(document.getElementById('audioMsg'), err.message, 'error');
        }
    }

    /* ---------------- 初始化 ---------------- */
    function init() {
        document.getElementById('entryForm').addEventListener('submit', submitEntry);
        document.getElementById('cancelEntryBtn').addEventListener('click', closeEntryForm);
        document.getElementById('importForm').addEventListener('submit', submitImport);
        document.getElementById('importToggleBtn').addEventListener('click', openImport);
        document.getElementById('importCancelBtn').addEventListener('click', () => showPanel('importForm', false));
        document.getElementById('unitForm').addEventListener('submit', submitUnit);
        document.getElementById('bookForm').addEventListener('submit', submitBook);
        document.getElementById('newEntryBtn').addEventListener('click', () => openEntryForm(null));
        document.getElementById('newUnitBtn').addEventListener('click', () => {
            document.getElementById('unitFormBook').textContent = window.PDState.currentBookName || '—';
            showPanel('unitForm', true);
            showPanel('entryForm', false);
            showPanel('importForm', false);
            showPanel('bookForm', false);
            document.getElementById('fUnitNo').focus();
        });
        document.getElementById('newBookBtn').addEventListener('click', () => {
            showPanel('bookForm', true);
            showPanel('entryForm', false);
            showPanel('importForm', false);
            showPanel('unitForm', false);
            document.getElementById('fBookCode').focus();
        });
        document.getElementById('unitCancelBtn').addEventListener('click', () => showPanel('unitForm', false));
        document.getElementById('bookCancelBtn').addEventListener('click', () => showPanel('bookForm', false));
        document.getElementById('auditRefreshBtn').addEventListener('click', loadAudit);

        document.getElementById('audioPickFileBtn').addEventListener('click', pickAudioFile);
        document.getElementById('audioFileInput').addEventListener('change', onAudioFileChosen);
        document.getElementById('audioRecordBtn').addEventListener('click', startRecording);
        document.getElementById('audioStopBtn').addEventListener('click', stopRecording);
        document.getElementById('audioCancelBtn').addEventListener('click', closeAudioModal);
        document.getElementById('audioDeleteBtn').addEventListener('click', deleteTeacherAudio);

        // 生字列與待審核列的按鈕都靠事件委派（動態產生的節點不個別綁定）
        document.getElementById('vocabList').addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            if (!button) return;
            const entryId = button.dataset.entryId;
            if (button.dataset.action === 'speak') window.PDVocab.speakEntry(entryId, button);
            if (button.dataset.action === 'edit-entry') {
                const entry = (window.PDState.entries || []).find((e) => String(e.id) === String(entryId));
                if (entry) openEntryForm(entry);
            }
            if (button.dataset.action === 'delete-entry') deleteEntry(entryId, button);
            if (button.dataset.action === 'upload-audio') openAudioModal(entryId);
        });
        document.getElementById('pendingList').addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            if (!button) return;
            if (button.dataset.action === 'approve-entry') review(button.dataset.entryId, 'approve');
            if (button.dataset.action === 'reject-entry') review(button.dataset.entryId, 'reject');
        });
    }

    window.PDAdmin = { init, loadAudit, openEntryForm, closeEntryForm, renderPending, openAudioModal, closeAudioModal };
})();

/* 介面語言（i18n）
 *
 * ★ 預設語言是英文（使用者 2026-10-07 指定）；使用者可以自己切換成中文，選擇記在 localStorage。
 * ★ 這裡是「所有介面文字」的唯一來源：
 *   - 靜態 HTML 用 data-i18n / data-i18n-placeholder / data-i18n-title 標記，開站與切換語言時掃一遍
 *   - 動態字串一律用 t('key')，不要在 JS 裡寫死中文
 *   - 後端錯誤訊息是英文（預設語言）＋ error code；中文由 errors.* 對照回來（見 errorMessage()）
 *   新增字串時兩種語言都要加，tests/i18n.test.js 會把「漏掉的鍵」抓出來。
 */
(function () {
    const DICT = {
        en: {
            'a11y.loading': 'Loading…',
            'app.subtitle': 'English Vocabulary Dictionary',
            'app.search': 'Search words, Chinese or English…',
            'app.footerVersion': 'PV_Dictionary {version}',
            'app.footerSource': 'Data: {name}',
            'app.footerTts': 'Pronunciations play the teacher recording when available, otherwise the browser voice',

            'nav.login': 'Sign in',
            'nav.logout': 'Sign out',
            'nav.manage': '✏️ Manage',
            'nav.manageClose': '✏️ Close',
            'lang.label': 'Language',
            'lang.en': 'EN',
            'lang.zh': '中文',

            'book.label': 'Book',
            'unit.label': 'Unit',
            'unit.words': '{n} words',
            'unit.pending': '{n} awaiting review',
            'unit.found': 'found {n}',
            'unit.print': '🖨 Print',
            'unit.noTts': 'This browser has no speech synthesis: words without a teacher recording cannot be played (try Chrome, Safari or Edge).',
            'unit.empty': 'No vocabulary in this unit yet.',
            'unit.noMatch': 'No words match your search.',

            'speak.play': 'Play the pronunciation of {word}',
            'speak.teacherTitle': 'Play the teacher recording',
            'speak.ttsTitle': 'Play with the browser voice',
            'speak.unsupported': 'This browser has no speech synthesis — use the teacher recording instead',
            'speak.teacherToast': 'Teacher recording: {word}',
            'speak.ttsToast': 'Browser voice: {word}',
            'speak.failed': 'Playback failed',

            'badge.teacherAudio': '👩‍🏫 Teacher recording',
            'status.pending': '⏳ Awaiting review',
            'status.draft': 'Draft',
            'status.rejected': '↩️ Returned',

            'action.edit': '✏️ Edit',
            'action.delete': '🗑 Delete',
            'action.deleteConfirm': '🗑 Press again to confirm',
            'action.record': '🎙 Record / upload',
            'action.replaceRecord': '🎙 Replace recording',

            'picker.noWordsTitle': 'No words to look up yet',
            'picker.noBooks': 'This dictionary has no books or units yet. This is what a student sees.',
            'picker.noUnits': 'The current book has no units yet. This is what a student sees.',
            'picker.stepsTitle': 'Teachers and administrators: sign in, then use “✏️ Manage” in the top right corner, in this order.',
            'picker.step1': '“📗 New book” → enter a code (e.g. B5A) and a name',
            'picker.step2': '“🏗 New unit” → enter a unit number and title (e.g. Unit 1 My New School)',
            'picker.step3': '“➕ New word” or “📋 Paste a list” → add the word, pronunciation, part of speech, Chinese and English meaning',
            'picker.step4': 'To add a teacher recording, press “🎙 Record / upload” on the word card',

            'admin.newEntry': '➕ New word',
            'admin.import': '📋 Paste a list',
            'admin.newUnit': '🏗 New unit',
            'admin.newBook': '📗 New book',
            'admin.hintNoBook': 'There are no books yet: press “📗 New book” first, then create a unit, then you can add words.',
            'admin.hintNoUnit': 'This book has no units yet: press “🏗 New unit” to create the first one, then you can add words.',
            'admin.needUnit': 'Please create or select a unit first',
            'admin.needBookUnit': 'Please create a book and a unit first',
            'admin.titleNewBook': 'Create a new book',
            'admin.titleUnitFor': 'Add to {book}',
            'admin.titleNeedBook': 'Create a book first',
            'admin.titleNeedUnit': 'Select or create a unit first',

            'entry.newTitle': '➕ New word',
            'entry.editTitle': '✏️ Edit word: {word}',
            'entry.newNote': 'Press “Save” to add it to this unit right away.',
            'entry.editNote': 'Press “Save” to apply the changes immediately.',
            'entry.headword': 'Word *',
            'entry.pos': 'Part of speech',
            'entry.ipaUs': 'Pronunciation (US IPA)',
            'entry.ipaUk': 'Pronunciation (UK IPA)',
            'entry.zh': 'Chinese meaning',
            'entry.en': 'English meaning',
            'entry.exampleEn': 'English example',
            'entry.exampleZh': 'Chinese example',
            'entry.save': 'Save',
            'entry.cancel': 'Cancel',
            'entry.saved': 'Changes saved.',
            'entry.created': 'Added to this unit.',
            'entry.createdPending': 'Submitted — students will see it after a teacher approves it.',
            'entry.toastUpdated': 'Word updated',
            'entry.toastCreated': 'Word added',
            'entry.toastPending': 'Submitted for review',

            'import.title': '📋 Paste a list of words',
            'import.note': 'One word per line, columns separated by Tab: <code>word ⇥ pronunciation ⇥ part of speech ⇥ Chinese ⇥ English</code> (at least one meaning; words already in the unit are skipped).',
            'import.textarea': 'Paste here',
            'import.placeholder': 'atmosphere	/ˈæt.mə.sfɪər/	n.	氣氛	the feeling of a place',
            'import.run': 'Import',
            'import.result': 'Added {created}',
            'import.skipped': ', skipped {skipped} (duplicates or blank)',
            'import.errors': ', {n} line(s) had the wrong format',
            'import.pendingNote': ', status: awaiting review',
            'import.empty': 'There is nothing to import.',

            'unitForm.title': '🏗 New unit',
            'unitForm.note': 'Added to the current book: {book}',
            'unitForm.no': 'Unit number *',
            'unitForm.titleField': 'Unit title',
            'unitForm.create': 'Create unit',
            'unitForm.done': 'Unit {n} created',
            'unitForm.toast': 'Unit created',

            'bookForm.title': '📗 New book',
            'bookForm.note': 'It will appear in the book picker at the top.',
            'bookForm.code': 'Code *',
            'bookForm.name': 'Book name *',
            'bookForm.grade': 'Grade',
            'bookForm.create': 'Create book',
            'bookForm.done': '{name} created',
            'bookForm.toast': 'Book created',

            'pending.title': '⏳ Words awaiting review',
            'pending.noteTeacher': 'Words added by class representatives appear to students only after a teacher approves them.',
            'pending.noteRep': 'Your words are waiting for a teacher to approve them; students cannot see them yet.',
            'pending.by': 'Added by {user} on {date}',
            'pending.approve': '✅ Approve',
            'pending.reject': '↩️ Return',
            'pending.approved': 'Approved — students can see it now',
            'pending.rejected': 'Returned',

            'audit.title': '🧾 Recent activity',
            'audit.reload': 'Reload',
            'audit.empty': 'No records yet.',
            'audit.failed': 'Could not load: {message}',

            'audio.titlePrefix': '🎙 Teacher recording',
            'backend.json': 'Local JSON file (demo)',
            'backend.supabase': 'Supabase (PostgreSQL)',
            'audio.note': 'Upload an audio file, or record with the microphone (30 seconds or less, max 1MB). Students hear the teacher recording first when they press 🔊.',
            'audio.pick': '📁 Choose a file',
            'audio.record': '🎙 Start recording',
            'audio.stop': '⏹ Stop and save',
            'audio.delete': '🗑 Delete current recording',
            'audio.close': 'Close',
            'audio.existing': 'This word already has a teacher recording; uploading again replaces it.',
            'audio.uploading': 'Uploading…',
            'audio.saved': 'Saved — 🔊 plays this recording now.',
            'audio.toastSaved': 'Teacher recording saved',
            'audio.tooBig': 'File too large ({kb}KB) — the limit is 1MB',
            'audio.readFailed': 'Could not read the file',
            'audio.noMic': 'This browser cannot record — use “Choose a file” instead.',
            'audio.recording': 'Recording… press “Stop and save” when you are done.',
            'audio.recordingSeconds': 'Recording… {seconds}s (max 60s)',
            'audio.emptyRecording': 'Nothing was recorded — please try again.',
            'audio.micFailed': 'Cannot use the microphone: {message}',
            'audio.deleted': 'Teacher recording deleted — the browser voice will be used',
            'audio.replaced': 'replaced the previous recording',

            'users.title': '👥 Accounts',
            'users.note': 'Administrators can create accounts and change roles. A class representative adds words that a teacher must approve.',
            'users.reload': 'Reload',
            'users.create': '➕ New account',
            'users.created': 'Account created',
            'users.updated': 'Saved',
            'users.deleted': 'Account deleted',
            'users.roleChanged': 'Role changed',
            'users.colAccount': 'Account',
            'users.colName': 'Display name',
            'users.colRole': 'Role',
            'users.colStatus': 'Status',
            'users.colLastLogin': 'Last sign-in',
            'users.colActions': 'Actions',
            'users.active': 'Active',
            'users.inactive': 'Disabled',
            'users.enable': 'Enable',
            'users.disable': 'Disable',
            'users.resetPassword': 'Reset password',
            'users.delete': 'Delete',
            'users.deleteConfirm': 'Press again to confirm',
            'users.self': 'you',
            'users.never': 'never',
            'users.grantHint': '{n} permission(s)',
            'users.username': 'Account *',
            'users.displayName': 'Display name',
            'users.password': 'Password *',
            'users.newPassword': 'New password (6–64 characters)',
            'users.createNote': 'The new account can sign in right away. Students do not need an account to look words up.',
            'users.roleLocked': 'Only a site manager can change this role',
            'users.selectRole': 'Choose a role',
            'users.editName': 'Edit name',
            'users.empty': 'No accounts yet.',

            'grants.title': '🔑 Permissions',
            'grants.note': 'Give one person the right to edit one book or one unit. Teachers and administrators can already edit everything.',
            'grants.person': 'Person',
            'grants.scope': 'Scope',
            'grants.bookScope': 'Whole book',
            'grants.unitScope': 'One unit',
            'grants.canEdit': 'Can edit',
            'grants.canPublish': 'Can also publish',
            'grants.add': 'Grant',
            'grants.remove': 'Remove',
            'grants.empty': 'No extra permissions yet.',
            'grants.created': 'Permission granted',
            'grants.removed': 'Permission removed',
            'grants.selectUser': 'Choose a person',
            'grants.selectBook': 'Choose a book',
            'grants.selectUnit': 'Choose a unit',
            'grants.editOnly': 'Edit',
            'grants.editPublish': 'Edit + publish',
            'grants.colWho': 'Person',
            'grants.colScope': 'Scope',
            'grants.colRights': 'Rights',
            'grants.colGrantedBy': 'Granted by',

            'shelf.title': 'Choose a book',
            'shelf.note': 'Tap a book cover to open its unit list.',
            'shelf.empty': 'No books have been added yet.',
            'units.empty': 'This book has no units yet.',
            'count.units': '{n} units',
            'nav.backToBooks': '← Books',
            'nav.backToUnits': '← Units',

            'admin.tabPending': 'To review',
            'admin.cover': '🖼 Book cover',
            'admin.menu': 'Manage menu',
            'pending.empty': 'Nothing waiting for review.',
            'cover.title': '🖼 Book cover',
            'cover.note': 'Take a photo of the book cover and upload it here. Students see it on the home screen.',
            'cover.book': 'Book',
            'cover.none': 'This book has no cover yet.',
            'cover.pick': '📁 Choose a photo',
            'cover.remove': '🗑 Remove cover',
            'cover.saved': 'Cover updated',
            'cover.deleted': 'Cover removed',

            'password.title': '🔑 Change my password',
            'password.note': 'Type your current password, then the new one (6–64 characters).',
            'password.current': 'Current password',
            'password.new': 'New password',
            'password.save': 'Save',
            'password.saved': 'Password updated',
            'password.open': 'Change my password',

            'login.title': 'Sign in',
            'login.note': 'Students can look words up without signing in. Teachers, class representatives and administrators sign in to edit.',
            'login.username': 'Account',
            'login.password': 'Password',
            'login.submit': 'Sign in',
            'login.cancel': 'Cancel',
            'login.welcome': 'Signed in as {name} ({role})',
            'login.loggedOut': 'Signed out',

            'toast.loadFailed': 'Could not load: {message}',
            'toast.langChanged': 'Language: English',

            'role.guest': 'Guest',
            'role.student': 'Student',
            'role.class_rep': 'Class representative',
            'role.teacher': 'Teacher',
            'role.admin': 'Web administrator',
            'role.web_manager': 'Site manager',

            'auditAction.LOGIN': 'Sign in',
            'auditAction.LOGOUT': 'Sign out',
            'auditAction.ENTRY_CREATE': 'Add word',
            'auditAction.ENTRY_UPDATE': 'Edit word',
            'auditAction.ENTRY_DELETE': 'Delete word',
            'auditAction.ENTRY_IMPORT': 'Import words',
            'auditAction.ENTRY_APPROVE': 'Approve word',
            'auditAction.ENTRY_REJECT': 'Return word',
            'auditAction.AUDIO_UPLOAD': 'Upload recording',
            'auditAction.AUDIO_DELETE': 'Delete recording',
            'auditAction.BOOK_CREATE': 'Add book',
            'auditAction.BOOK_UPDATE': 'Edit book',
            'auditAction.UNIT_CREATE': 'Add unit',
            'auditAction.UNIT_UPDATE': 'Edit unit',
            'auditAction.UNIT_PUBLISH': 'Publish unit',
            'auditAction.UNIT_UNPUBLISH': 'Unpublish unit',
            'auditAction.USER_CREATE': 'Create user',
            'auditAction.USER_UPDATE': 'Update user',
            'auditAction.USER_DELETE': 'Delete user',
            'auditAction.GRANT_CREATE': 'Grant permission',
            'auditAction.GRANT_DELETE': 'Remove permission',
            'auditAction.COVER_UPLOAD': 'Upload cover',
            'auditAction.COVER_DELETE': 'Remove cover',
            'auditAction.PASSWORD_CHANGE': 'Change own password',

            'errors.AUTH_REQUIRED': 'Please sign in first',
            'errors.FORBIDDEN': 'You do not have permission to do that',
            'errors.UNIT_NOT_FOUND': 'This unit does not exist',
            'errors.ENTRY_NOT_FOUND': 'This word does not exist',
            'errors.BOOK_NOT_FOUND': 'This book does not exist',
            'errors.AUDIO_NOT_FOUND': 'This recording does not exist',
            'errors.USER_NOT_FOUND': 'This user does not exist',
            'errors.HEADWORD_REQUIRED': 'Please enter the word',
            'errors.MEANING_REQUIRED': 'Enter a Chinese or an English meaning',
            'errors.DUPLICATE_ENTRY': 'This unit already has “{word}”',
            'errors.PUBLISHED_NEEDS_TEACHER': 'Only teachers and above can change a published word',
            'errors.INVALID_AUDIO_TYPE': 'Unsupported audio format ({mime})',
            'errors.AUDIO_TOO_LARGE': 'The recording is too large ({kb}KB) — the limit is 1MB',
            'errors.AUDIO_TOO_LONG': 'The recording is too long — the limit is 60 seconds',
            'errors.AUDIO_EMPTY': 'The audio file is empty',
            'errors.AUDIO_BAD_BASE64': 'The audio content is not valid base64',
            'errors.UNIT_NUMBER': 'The unit number must be a number from 1 to 99',
            'errors.DUPLICATE_UNIT': '{book} already has Unit {n}',
            'errors.BOOK_NAME_REQUIRED': 'Please enter the book name',
            'errors.DUPLICATE_CODE': 'The code “{code}” is already used',
            'errors.LOGIN_REQUIRED_FIELDS': 'Enter your account and password',
            'errors.LOGIN_FAILED': 'Wrong account or password',
            'errors.LOGIN_LOCKED_IP': 'Too many failed sign-ins from this network — try again in 15 minutes',
            'errors.LOGIN_LOCKED_USER': 'Too many failed sign-ins for this account — try again in 15 minutes',
            'errors.REVIEW_ACTION': 'The review action must be approve or reject',
            'errors.NOT_PENDING': 'This word is not awaiting review',
            'errors.IMPORT_EMPTY': 'There is nothing to import',
            'errors.ORIGIN_NOT_ALLOWED': 'This request came from an unknown site',
            'errors.BAD_JSON': 'The request body is not valid JSON',
            'errors.TOO_LARGE': 'The request body is too large',
            'errors.SERVER': 'Something went wrong on the server',
            'errors.NETWORK': 'Could not reach the server',
            'errors.UNIT_NOT_PUBLISHED': 'This unit has not been published yet',
            'errors.NO_EDIT_PERMISSION': 'You cannot edit this unit',
            'errors.USERNAME_FORMAT': 'The account name must be 3–32 letters, digits or underscores',
            'errors.PASSWORD_LENGTH': 'The password must be 6–64 characters long',
            'errors.USERNAME_TAKEN': 'This account name is already taken',
            'errors.ROLE_CREATE_FORBIDDEN': 'You cannot create that role',
            'errors.ROLE_ASSIGN_FORBIDDEN': 'You cannot assign that role',
            'errors.USER_MANAGE_FORBIDDEN': 'You cannot manage this user',
            'errors.LAST_WEB_MANAGER': 'At least one site manager must remain',
            'errors.TARGET_NOT_FOUND': 'The book or unit does not exist',
            'errors.GRANT_TARGET_REQUIRED': 'Please choose a book or a unit',
            'errors.GRANT_NOT_FOUND': 'This permission entry does not exist',
            'errors.API_NOT_FOUND': 'No such API: {method} {path}',
            'errors.GRANT_EXISTS': 'This user already has this permission',
            'errors.CANNOT_DELETE_SELF': 'You cannot delete your own account',
            'errors.CURRENT_PASSWORD_WRONG': 'Your current password is not correct',
            'errors.COVER_NOT_FOUND': 'This book has no cover yet',
            'errors.INVALID_COVER_TYPE': 'Cover images must be JPEG, PNG or WebP ({mime} was sent)',
            'errors.COVER_BAD_BASE64': 'The image data could not be read',
            'errors.COVER_EMPTY': 'The image file is empty',
            'errors.COVER_TOO_LARGE': 'The image is too large ({kb}KB) — please use one under 2MB',
            'errors.DB_UNAVAILABLE': 'The database is not reachable right now ({message})',
            'errors.DB_WRITE_FAILED': 'Your change could not be saved ({message}) — please try again'
        },
        zh: {
            'a11y.loading': '載入中…',
            'app.subtitle': '英文生字字典',
            'app.search': '搜尋生字、中文或英文解釋…',
            'app.footerVersion': 'PV_Dictionary {version}',
            'app.footerSource': '資料來源：{name}',
            'app.footerTts': '讀音優先使用老師錄音，沒有錄音時使用瀏覽器語音合成',

            'nav.login': '登入',
            'nav.logout': '登出',
            'nav.manage': '✏️ 管理',
            'nav.manageClose': '✏️ 收起管理',
            'lang.label': '語言',
            'lang.en': 'EN',
            'lang.zh': '中文',

            'book.label': '書本',
            'unit.label': '單元',
            'unit.words': '共 {n} 個生字',
            'unit.pending': '待審核 {n} 個',
            'unit.found': '搜尋到 {n} 個',
            'unit.print': '🖨 列印',
            'unit.noTts': '這個瀏覽器不支援語音合成：沒有老師錄音的生字無法播放讀音（建議用 Chrome / Safari / Edge）。',
            'unit.empty': '這個單元還沒有生字。',
            'unit.noMatch': '沒有符合搜尋條件的生字。',

            'speak.play': '播放 {word} 的讀音',
            'speak.teacherTitle': '播放老師錄音',
            'speak.ttsTitle': '用瀏覽器語音合成播放讀音',
            'speak.unsupported': '這個瀏覽器不支援語音合成，請改用老師錄音',
            'speak.teacherToast': '播放老師錄音：{word}',
            'speak.ttsToast': '語音合成：{word}',
            'speak.failed': '播放失敗',

            'badge.teacherAudio': '👩‍🏫 老師錄音',
            'status.pending': '⏳ 待審核',
            'status.draft': '草稿',
            'status.rejected': '↩️ 已退回',

            'action.edit': '✏️ 編輯',
            'action.delete': '🗑 刪除',
            'action.deleteConfirm': '🗑 再按一次確認',
            'action.record': '🎙 錄音 / 上傳',
            'action.replaceRecord': '🎙 換錄音',

            'picker.noWordsTitle': '還沒有可以查的生字',
            'picker.noBooks': '這本字典目前沒有任何書本與單元。學生進來時會看到這個畫面。',
            'picker.noUnits': '目前的書本還沒有任何單元。學生進來時會看到這個畫面。',
            'picker.stepsTitle': '老師或管理員：先登入，再按右上角的「✏️ 管理」照下面順序建立，學生立刻就能查。',
            'picker.step1': '「📗 新增書本」→ 填代號（例：B5A）與書名',
            'picker.step2': '「🏗 新增單元」→ 填單元編號與標題（例：Unit 1 My New School）',
            'picker.step3': '「➕ 新增生字」或「📋 批次貼上」→ 加入生字、讀音、詞性、中文與英文解釋',
            'picker.step4': '需要老師錄音時，在生字卡按「🎙 錄音 / 上傳」',

            'admin.newEntry': '➕ 新增生字',
            'admin.import': '📋 批次貼上',
            'admin.newUnit': '🏗 新增單元',
            'admin.newBook': '📗 新增書本',
            'admin.hintNoBook': '目前還沒有任何書本：請先按「📗 新增書本」，再建立單元，然後就可以加入生字。',
            'admin.hintNoUnit': '這本書還沒有單元：請按「🏗 新增單元」建立第一個單元，之後就能加入生字。',
            'admin.needUnit': '請先建立或選擇一個單元',
            'admin.needBookUnit': '請先建立一本書與單元',
            'admin.titleNewBook': '建立一本新的書本',
            'admin.titleUnitFor': '加到 {book}',
            'admin.titleNeedBook': '請先建立一本書',
            'admin.titleNeedUnit': '請先選擇或建立單元',

            'entry.newTitle': '➕ 新增生字',
            'entry.editTitle': '✏️ 修改生字：{word}',
            'entry.newNote': '填好後按「儲存」，會立即加到這個單元。',
            'entry.editNote': '修改後按「儲存」立即生效。',
            'entry.headword': '生字 *',
            'entry.pos': '詞性',
            'entry.ipaUs': '讀音（美式 IPA）',
            'entry.ipaUk': '讀音（英式 IPA）',
            'entry.zh': '中文解釋',
            'entry.en': '英文解釋',
            'entry.exampleEn': '英文例句',
            'entry.exampleZh': '中文例句',
            'entry.save': '儲存',
            'entry.cancel': '取消',
            'entry.saved': '已儲存修改。',
            'entry.created': '已新增到這個單元。',
            'entry.createdPending': '已送出，等老師核准後學生才看得到。',
            'entry.toastUpdated': '已更新生字',
            'entry.toastCreated': '已新增生字',
            'entry.toastPending': '已送出待審核',

            'import.title': '📋 批次貼上生字',
            'import.note': '一行一個生字，欄位用 Tab 分隔：<code>生字 ⇥ 讀音 ⇥ 詞性 ⇥ 中文解釋 ⇥ 英文解釋</code>（中文與英文解釋至少要有一個；已在同一單元的生字會自動略過）。',
            'import.textarea': '貼上內容',
            'import.placeholder': 'atmosphere	/ˈæt.mə.sfɪər/	n.	氣氛	the feeling of a place',
            'import.run': '匯入',
            'import.result': '新增 {created} 筆',
            'import.skipped': '，略過 {skipped} 筆（重複或空白）',
            'import.errors': '，{n} 行格式有問題',
            'import.pendingNote': '，狀態：待審核',
            'import.empty': '沒有可以匯入的內容。',

            'unitForm.title': '🏗 新增單元',
            'unitForm.note': '加到目前的書本：{book}',
            'unitForm.no': '單元編號 *',
            'unitForm.titleField': '單元標題',
            'unitForm.create': '建立單元',
            'unitForm.done': '已建立 Unit {n}',
            'unitForm.toast': '已建立單元',

            'bookForm.title': '📗 新增書本',
            'bookForm.note': '建立後會出現在最上方的書本選單。',
            'bookForm.code': '代號 *',
            'bookForm.name': '書名 *',
            'bookForm.grade': '年級',
            'bookForm.create': '建立書本',
            'bookForm.done': '已建立 {name}',
            'bookForm.toast': '已建立書本',

            'pending.title': '⏳ 待審核生字',
            'pending.noteTeacher': '科代表新增的生字，需要老師核准才會出現在學生的生字表。',
            'pending.noteRep': '你送出的生字正在等老師核准；核准後學生才看得到。',
            'pending.by': '由 {user} 新增於 {date}',
            'pending.approve': '✅ 核准',
            'pending.reject': '↩️ 退回',
            'pending.approved': '已核准，學生現在看得到了',
            'pending.rejected': '已退回',

            'audit.title': '🧾 最近的操作紀錄',
            'audit.reload': '重新載入',
            'audit.empty': '目前沒有紀錄。',
            'audit.failed': '讀取失敗：{message}',

            'audio.titlePrefix': '🎙 老師錄音',
            'backend.json': '本機 JSON 檔（Demo）',
            'backend.supabase': 'Supabase（PostgreSQL）',
            'audio.note': '可以上傳現成的音檔，或直接用麥克風錄一段（建議 30 秒內，上限 1MB）。學生按下 🔊 時會優先播放老師錄音。',
            'audio.pick': '📁 選擇檔案',
            'audio.record': '🎙 開始錄音',
            'audio.stop': '⏹ 停止並儲存',
            'audio.delete': '🗑 刪除現有錄音',
            'audio.close': '關閉',
            'audio.existing': '這個生字已經有老師錄音，重新上傳會取代舊的。',
            'audio.uploading': '上傳中…',
            'audio.saved': '已儲存，現在 🔊 會播放這段錄音。',
            'audio.toastSaved': '已儲存老師錄音',
            'audio.tooBig': '檔案太大（{kb}KB），上限 1MB',
            'audio.readFailed': '讀取檔案失敗',
            'audio.noMic': '這個瀏覽器不支援錄音，請改用「選擇檔案」。',
            'audio.recording': '錄音中…按「停止並儲存」結束。',
            'audio.recordingSeconds': '錄音中… {seconds} 秒（上限 60 秒）',
            'audio.emptyRecording': '沒有錄到聲音，再試一次。',
            'audio.micFailed': '無法使用麥克風：{message}',
            'audio.deleted': '已刪除老師錄音，之後會用語音合成',
            'audio.replaced': '已取代舊錄音',

            'users.title': '👥 帳號管理',
            'users.note': '管理員可以建立帳號與調整角色；科代表新增的生字需要老師核准。',
            'users.reload': '重新載入',
            'users.create': '➕ 新增帳號',
            'users.created': '已建立帳號',
            'users.updated': '已儲存',
            'users.deleted': '已刪除帳號',
            'users.roleChanged': '已變更角色',
            'users.colAccount': '帳號',
            'users.colName': '顯示名稱',
            'users.colRole': '角色',
            'users.colStatus': '狀態',
            'users.colLastLogin': '最後登入',
            'users.colActions': '操作',
            'users.active': '啟用中',
            'users.inactive': '已停用',
            'users.enable': '啟用',
            'users.disable': '停用',
            'users.resetPassword': '重設密碼',
            'users.delete': '刪除',
            'users.deleteConfirm': '再按一次確認',
            'users.self': '你自己',
            'users.never': '從未',
            'users.grantHint': '授權 {n} 筆',
            'users.username': '帳號 *',
            'users.displayName': '顯示名稱',
            'users.password': '密碼 *',
            'users.newPassword': '新密碼（6–64 個字元）',
            'users.createNote': '新帳號可以立即登入；學生查生字不需要帳號。',
            'users.roleLocked': '只有網站管理員可以改這個角色',
            'users.selectRole': '選擇角色',
            'users.editName': '改顯示名稱',
            'users.empty': '還沒有帳號。',

            'grants.title': '🔑 授權管理',
            'grants.note': '授權特定的人編輯某一本書或某一個單元；老師與管理員本來就可以編輯全部。',
            'grants.person': '授權對象',
            'grants.scope': '範圍',
            'grants.bookScope': '整本書',
            'grants.unitScope': '單一單元',
            'grants.canEdit': '可以編輯',
            'grants.canPublish': '也可以發佈',
            'grants.add': '新增授權',
            'grants.remove': '移除',
            'grants.empty': '目前沒有額外授權。',
            'grants.created': '已新增授權',
            'grants.removed': '已移除授權',
            'grants.selectUser': '選擇使用者',
            'grants.selectBook': '選擇書本',
            'grants.selectUnit': '選擇單元',
            'grants.editOnly': '可編輯',
            'grants.editPublish': '可編輯＋發佈',
            'grants.colWho': '授權對象',
            'grants.colScope': '範圍',
            'grants.colRights': '權限',
            'grants.colGrantedBy': '授權者',

            'shelf.title': '選擇書本',
            'shelf.note': '點擊書本封面進入單元目錄。',
            'shelf.empty': '還沒有加入任何書本。',
            'units.empty': '這本書還沒有任何單元。',
            'count.units': '{n} 個單元',
            'nav.backToBooks': '← 書本',
            'nav.backToUnits': '← 單元',

            'admin.tabPending': '待審核',
            'admin.cover': '🖼 書本封面',
            'admin.menu': '管理選單',
            'pending.empty': '目前沒有待審核的生字。',
            'cover.title': '🖼 書本封面',
            'cover.note': '把書本封面拍下來上傳到這裡；學生會在首頁看到。',
            'cover.book': '書本',
            'cover.none': '這本書還沒有封面。',
            'cover.pick': '📁 選擇圖片',
            'cover.remove': '🗑 移除封面',
            'cover.saved': '已更新封面',
            'cover.deleted': '已移除封面',

            'password.title': '🔑 修改我的密碼',
            'password.note': '先輸入目前的密碼，再輸入新密碼（6–64 個字元）。',
            'password.current': '目前的密碼',
            'password.new': '新密碼',
            'password.save': '儲存',
            'password.saved': '密碼已更新',
            'password.open': '修改我的密碼',

            'login.title': '登入',
            'login.note': '學生可以直接查生字，不需要登入。老師、科代表與管理員登入後才能編輯。',
            'login.username': '帳號',
            'login.password': '密碼',
            'login.submit': '登入',
            'login.cancel': '取消',
            'login.welcome': '已登入：{name}（{role}）',
            'login.loggedOut': '已登出',

            'toast.loadFailed': '載入失敗：{message}',
            'toast.langChanged': '語言：中文',

            'role.guest': '訪客',
            'role.student': '學生',
            'role.class_rep': '科代表',
            'role.teacher': '老師',
            'role.admin': '網頁管理員',
            'role.web_manager': '網站管理員',

            'auditAction.LOGIN': '登入',
            'auditAction.LOGOUT': '登出',
            'auditAction.ENTRY_CREATE': '新增生字',
            'auditAction.ENTRY_UPDATE': '修改生字',
            'auditAction.ENTRY_DELETE': '刪除生字',
            'auditAction.ENTRY_IMPORT': '批次匯入生字',
            'auditAction.ENTRY_APPROVE': '核准生字',
            'auditAction.ENTRY_REJECT': '退回生字',
            'auditAction.AUDIO_UPLOAD': '上傳老師錄音',
            'auditAction.AUDIO_DELETE': '刪除老師錄音',
            'auditAction.BOOK_CREATE': '新增書本',
            'auditAction.BOOK_UPDATE': '修改書本',
            'auditAction.UNIT_CREATE': '新增單元',
            'auditAction.UNIT_UPDATE': '修改單元',
            'auditAction.UNIT_PUBLISH': '發佈單元',
            'auditAction.UNIT_UNPUBLISH': '下架單元',
            'auditAction.USER_CREATE': '新增使用者',
            'auditAction.USER_UPDATE': '修改使用者',
            'auditAction.USER_DELETE': '刪除使用者',
            'auditAction.GRANT_CREATE': '新增授權',
            'auditAction.GRANT_DELETE': '移除授權',
            'auditAction.COVER_UPLOAD': '上傳書本封面',
            'auditAction.COVER_DELETE': '移除書本封面',
            'auditAction.PASSWORD_CHANGE': '修改自己的密碼',

            'errors.AUTH_REQUIRED': '請先登入',
            'errors.FORBIDDEN': '權限不足',
            'errors.UNIT_NOT_FOUND': '找不到這個單元',
            'errors.ENTRY_NOT_FOUND': '找不到這個生字',
            'errors.BOOK_NOT_FOUND': '找不到這本書',
            'errors.AUDIO_NOT_FOUND': '找不到音檔',
            'errors.USER_NOT_FOUND': '找不到這個使用者',
            'errors.HEADWORD_REQUIRED': '請輸入生字',
            'errors.MEANING_REQUIRED': '中文解釋與英文解釋至少要填一個',
            'errors.DUPLICATE_ENTRY': '這個單元已經有「{word}」了',
            'errors.PUBLISHED_NEEDS_TEACHER': '已發佈的生字需要老師以上才能修改',
            'errors.INVALID_AUDIO_TYPE': '不接受的音檔格式（{mime}）',
            'errors.AUDIO_TOO_LARGE': '錄音檔太大（{kb}KB），上限 1MB',
            'errors.AUDIO_TOO_LONG': '錄音太長（上限 60 秒）',
            'errors.AUDIO_EMPTY': '音檔是空的',
            'errors.AUDIO_BAD_BASE64': '音檔內容不是合法的 base64',
            'errors.UNIT_NUMBER': '單元編號必須是 1–99 的數字',
            'errors.DUPLICATE_UNIT': '{book} 已經有 Unit {n} 了',
            'errors.BOOK_NAME_REQUIRED': '請輸入書本名稱',
            'errors.DUPLICATE_CODE': '代號「{code}」已經有人用了',
            'errors.LOGIN_REQUIRED_FIELDS': '請輸入帳號與密碼',
            'errors.LOGIN_FAILED': '帳號或密碼錯誤',
            'errors.LOGIN_LOCKED_IP': '來自這個網路的登入失敗次數過多，請 15 分鐘後再試',
            'errors.LOGIN_LOCKED_USER': '這個帳號的登入失敗次數過多，請 15 分鐘後再試',
            'errors.REVIEW_ACTION': 'action 必須是 approve 或 reject',
            'errors.NOT_PENDING': '這個生字不是待審核狀態',
            'errors.IMPORT_EMPTY': '沒有可以匯入的內容',
            'errors.ORIGIN_NOT_ALLOWED': '來源不被允許',
            'errors.BAD_JSON': '送出的資料不是合法的 JSON',
            'errors.TOO_LARGE': '送出的內容太大',
            'errors.SERVER': '伺服器發生錯誤',
            'errors.NETWORK': '連不上伺服器',
            'errors.UNIT_NOT_PUBLISHED': '這個單元尚未發佈',
            'errors.NO_EDIT_PERMISSION': '你沒有編輯這個單元的權限',
            'errors.USERNAME_FORMAT': '帳號只能是 3–32 個英文字母、數字或底線',
            'errors.PASSWORD_LENGTH': '密碼長度必須是 6–64 個字元',
            'errors.USERNAME_TAKEN': '這個帳號已經存在',
            'errors.ROLE_CREATE_FORBIDDEN': '你不能建立這個角色',
            'errors.ROLE_ASSIGN_FORBIDDEN': '你不能指派這個角色',
            'errors.USER_MANAGE_FORBIDDEN': '你不能管理這個使用者',
            'errors.LAST_WEB_MANAGER': '至少要保留一位網站管理員',
            'errors.TARGET_NOT_FOUND': '書本或單元不存在',
            'errors.GRANT_TARGET_REQUIRED': '請指定書本或單元',
            'errors.GRANT_NOT_FOUND': '找不到這筆授權',
            'errors.API_NOT_FOUND': '沒有這個 API：{method} {path}',
            'errors.GRANT_EXISTS': '這位使用者已經有這個授權',
            'errors.CANNOT_DELETE_SELF': '不能刪除自己的帳號',
            'errors.CURRENT_PASSWORD_WRONG': '目前的密碼不正確',
            'errors.COVER_NOT_FOUND': '這本書還沒有封面',
            'errors.INVALID_COVER_TYPE': '封面只能是 JPEG、PNG 或 WebP（收到的是 {mime}）',
            'errors.COVER_BAD_BASE64': '圖片資料讀不出來',
            'errors.COVER_EMPTY': '圖片檔是空的',
            'errors.COVER_TOO_LARGE': '圖片太大了（{kb}KB），請用 2MB 以下的',
            'errors.DB_UNAVAILABLE': '資料庫現在連不上（{message}）',
            'errors.DB_WRITE_FAILED': '這次的修改沒有存進資料庫（{message}），請再試一次'
        }
    };

    const SUPPORTED = ['en', 'zh'];
    const DEFAULT_LANG = 'en';
    const STORAGE_KEY = 'pd-lang';

    let current = DEFAULT_LANG;

    function normalize(lang) {
        const value = String(lang || '').toLowerCase();
        if (SUPPORTED.includes(value)) return value;
        if (value.startsWith('zh')) return 'zh';
        if (value.startsWith('en')) return 'en';
        return null;
    }

    /* 只讀 UI 偏好，不涉及任何授權判斷（授權一律在後端） */
    function storedLang() {
        try {
            return normalize(window.localStorage.getItem(STORAGE_KEY));
        } catch (err) {
            return null;
        }
    }

    function detectLang() {
        return storedLang() || DEFAULT_LANG;
    }

    /* 插值：{name} 會被換成 vars.name。
     * ★ 沒給值的佔位符要「整段拿掉」，不能留 {message} 在畫面上（使用者真的看到過
     *   「這次的修改沒有存進資料庫（{message}）」），也不能留空括號。 */
    function interpolate(text, vars) {
        const values = vars || {};
        const filled = String(text).replace(/\{(\w+)\}/g, (match, key) => (
            values[key] === undefined || values[key] === null ? '' : String(values[key])
        ));
        return filled
            .replace(/[（(]\s*[)）]/g, '')     /* 值被拿掉後留下的空括號 */
            .replace(/[ \t]{2,}/g, ' ')        /* 收掉多餘空白 */
            .replace(/\s+([，。、；：])/g, '$1')
            .trim();
    }

    function t(key, vars) {
        const table = DICT[current] || DICT[DEFAULT_LANG];
        const fallback = DICT[DEFAULT_LANG];
        const value = table[key] !== undefined ? table[key] : fallback[key];
        if (value === undefined) return key;
        return interpolate(value, vars);
    }

    function has(key, lang) {
        return Object.prototype.hasOwnProperty.call(DICT[lang || current], key);
    }

    /* 後端錯誤 → 目前語言。後端回的是英文（預設語言）＋ code，這裡只負責翻譯。 */
    function errorMessage(error) {
        if (!error) return t('errors.SERVER');
        const code = error.code && String(error.code).startsWith('errors.') ? error.code : (error.code ? `errors.${error.code}` : null);
        if (code && has(code)) return t(code, error.details || {});
        return error.message || t('errors.SERVER');
    }

    function roleLabel(role) {
        const key = `role.${role}`;
        return has(key) ? t(key) : role;
    }

    function auditActionLabel(action, fallback) {
        const key = `auditAction.${action}`;
        if (has(key)) return t(key);
        return fallback || action;
    }

    /* 掃靜態 HTML：data-i18n（textContent）、data-i18n-placeholder、data-i18n-title、data-i18n-aria */
    function applyStaticTranslations(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-i18n]').forEach((node) => {
            node.textContent = t(node.dataset.i18n);
        });
        scope.querySelectorAll('[data-i18n-html]').forEach((node) => {
            node.innerHTML = t(node.dataset.i18nHtml);
        });
        scope.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
            node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
        });
        scope.querySelectorAll('[data-i18n-title]').forEach((node) => {
            node.setAttribute('title', t(node.dataset.i18nTitle));
        });
        scope.querySelectorAll('[data-i18n-aria]').forEach((node) => {
            node.setAttribute('aria-label', t(node.dataset.i18nAria));
        });
    }

    function setLang(lang, options) {
        const next = normalize(lang) || DEFAULT_LANG;
        current = next;
        try {
            window.localStorage.setItem(STORAGE_KEY, next);
        } catch (err) {
            /* 隱私模式下寫不進去：仍然套用本次的語言 */
        }
        document.documentElement.setAttribute('lang', next === 'zh' ? 'zh-Hant' : 'en');
        applyStaticTranslations();
        if (!options || options.silent !== true) {
            document.dispatchEvent(new CustomEvent('pd:langchange', { detail: { lang: next } }));
        }
        return next;
    }

    function init() {
        current = detectLang();
        document.documentElement.setAttribute('lang', current === 'zh' ? 'zh-Hant' : 'en');
        applyStaticTranslations();
        return current;
    }

    window.PDI18n = {
        DICT,
        SUPPORTED,
        DEFAULT_LANG,
        STORAGE_KEY,
        t,
        has,
        errorMessage,
        roleLabel,
        auditActionLabel,
        applyStaticTranslations,
        setLang,
        init,
        detectLang,
        get lang() {
            return current;
        }
    };
})();

/* 後端回傳的錯誤訊息（伺服器端語言的唯一來源）
 *
 * 為什麼放這裡：預設介面語言是英文，API 的訊息就用英文；中文由前端的
 * public/js/i18n.js 依 code 翻譯（errors.*）。每一筆回應都帶 code，
 * 所以前端不必解析英文字串，兩種語言也不會各自漂移。
 */
const MESSAGES = {
    AUTH_REQUIRED: 'Please sign in first',
    FORBIDDEN: 'You do not have permission to do that',
    NO_EDIT_PERMISSION: 'You cannot edit this unit',
    UNIT_NOT_FOUND: 'This unit does not exist',
    UNIT_NOT_PUBLISHED: 'This unit has not been published yet',
    ENTRY_NOT_FOUND: 'This word does not exist',
    BOOK_NOT_FOUND: 'This book does not exist',
    AUDIO_NOT_FOUND: 'This recording does not exist',
    USER_NOT_FOUND: 'This user does not exist',
    GRANT_NOT_FOUND: 'This permission entry does not exist',
    HEADWORD_REQUIRED: 'Please enter the word',
    MEANING_REQUIRED: 'Enter a Chinese or an English meaning',
    DUPLICATE_ENTRY: 'This unit already has “{word}”',
    PUBLISHED_NEEDS_TEACHER: 'Only teachers and above can change a published word',
    INVALID_AUDIO_TYPE: 'Unsupported audio format ({mime})',
    AUDIO_TOO_LARGE: 'The recording is too large ({kb}KB) — the limit is 1MB',
    AUDIO_TOO_LONG: 'The recording is too long — the limit is 60 seconds',
    AUDIO_EMPTY: 'The audio file is empty',
    AUDIO_BAD_BASE64: 'The audio content is not valid base64',
    UNIT_NUMBER: 'The unit number must be a number from 1 to 99',
    DUPLICATE_UNIT: '{book} already has Unit {n}',
    BOOK_NAME_REQUIRED: 'Please enter the book name',
    DUPLICATE_CODE: 'The code “{code}” is already used',
    LOGIN_REQUIRED_FIELDS: 'Enter your account and password',
    LOGIN_FAILED: 'Wrong account or password',
    LOGIN_LOCKED_IP: 'Too many failed sign-ins from this network — try again in 15 minutes',
    LOGIN_LOCKED_USER: 'Too many failed sign-ins for this account — try again in 15 minutes',
    REVIEW_ACTION: 'The review action must be approve or reject',
    NOT_PENDING: 'This word is not awaiting review',
    IMPORT_EMPTY: 'There is nothing to import',
    ORIGIN_NOT_ALLOWED: 'This request came from an unknown site',
    BAD_JSON: 'The request body is not valid JSON',
    TOO_LARGE: 'The request body is too large',
    SERVER: 'Something went wrong on the server',
    /* NETWORK 是前端自己產生的（連不上伺服器），放這裡讓兩邊的 code 清單一致 */
    NETWORK: 'Could not reach the server',
    API_NOT_FOUND: 'No such API: {method} {path}',
    USERNAME_FORMAT: 'The account name must be 3–32 letters, digits or underscores',
    PASSWORD_LENGTH: 'The password must be 6–64 characters long',
    USERNAME_TAKEN: 'This account name is already taken',
    ROLE_CREATE_FORBIDDEN: 'You cannot create that role',
    ROLE_ASSIGN_FORBIDDEN: 'You cannot assign that role',
    USER_MANAGE_FORBIDDEN: 'You cannot manage this user',
    LAST_WEB_MANAGER: 'At least one site manager must remain',
    TARGET_NOT_FOUND: 'The book or unit does not exist',
    GRANT_TARGET_REQUIRED: 'Please choose a book or a unit',
    GRANT_EXISTS: 'This user already has this permission',
    CANNOT_DELETE_SELF: 'You cannot delete your own account',
    CURRENT_PASSWORD_WRONG: 'Your current password is not correct',
    COVER_NOT_FOUND: 'This book has no cover yet',
    INVALID_COVER_TYPE: 'Cover images must be JPEG, PNG or WebP ({mime} was sent)',
    COVER_BAD_BASE64: 'The image data could not be read',
    COVER_EMPTY: 'The image file is empty',
    COVER_TOO_LARGE: 'The image is too large ({kb}KB) — please use one under 2MB',
    DB_UNAVAILABLE: 'The database is not reachable right now ({message})',
    DB_WRITE_FAILED: 'Your change could not be saved ({message}) — please try again'
};

/* 與前端相同的 {name} 插值規則，避免兩邊各寫一套 */
function msg(code, vars) {
    const template = MESSAGES[code] || code;
    if (!vars) return template;
    return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        vars[key] === undefined || vars[key] === null ? match : String(vars[key])
    ));
}

module.exports = { MESSAGES, msg };

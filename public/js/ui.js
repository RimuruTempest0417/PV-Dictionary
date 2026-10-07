/* 共用 UI 小工具
 * - el()：用 DOM API 建立元素（一律 textContent，不碰 innerHTML → 使用者輸入不可能變成 HTML）
 * - toast()：右下角的短訊息
 */
(function () {
    function el(tag, props, children) {
        const node = document.createElement(tag);
        const options = props || {};
        if (options.class) node.className = options.class;
        if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
        if (options.attrs) {
            for (const [key, value] of Object.entries(options.attrs)) {
                if (value === null || value === undefined || value === false) continue;
                if (value === true) node.setAttribute(key, '');
                else node.setAttribute(key, String(value));
            }
        }
        if (options.dataset) {
            for (const [key, value] of Object.entries(options.dataset)) {
                if (value === null || value === undefined) continue;
                node.dataset[key] = String(value);
            }
        }
        if (options.on) {
            for (const [event, handler] of Object.entries(options.on)) node.addEventListener(event, handler);
        }
        const list = Array.isArray(children) ? children : (children ? [children] : []);
        for (const child of list) {
            if (child === null || child === undefined || child === false) continue;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return node;
    }

    function clear(node) {
        if (!node) return;
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    let toastTimer = null;
    function toast(message, type) {
        const box = document.getElementById('toast');
        if (!box) return;
        box.textContent = String(message);
        box.className = type === 'error' ? 'toast is-error' : 'toast';
        box.hidden = false;
        if (toastTimer) window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
            box.hidden = true;
        }, type === 'error' ? 5200 : 3200);
    }

    function setFormMessage(node, message, type) {
        if (!node) return;
        node.textContent = message ? String(message) : '';
        node.className = type ? `form-msg is-${type}` : 'form-msg';
    }

    function formatDateTime(iso) {
        if (!iso) return '';
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return String(iso);
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    window.PDUI = { el, clear, toast, setFormMessage, formatDateTime };
})();

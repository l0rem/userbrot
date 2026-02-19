export function telegramMarkdownToHtml(text: string): string {
    // 1. Escape HTML entities
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // 2. Bold: **text** -> <b>text</b>
    html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

    // 3. Italic: *text* or _text_ -> <i>text</i>  (Ignoring intra-word underscores)
    html = html.replace(/(^|[^\w])_([^_]+)_([^\w]|$)/g, "$1<i>$2</i>$3");
    html = html.replace(/\*(?!\*)(.+?)\*(?!\*)/g, "<i>$1</i>");

    // 4. Strikethrough: ~~text~~ -> <s>text</s>
    html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

    // 5. Code block: ```language\ncode\n``` -> <pre><code class="language-language">code</code></pre>
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        if (lang) {
            return `<pre><code class="language-${lang}">${code}</code></pre>`;
        }
        return `<pre><code>${code}</code></pre>`;
    });

    // 6. Inline code: `code` -> <code>code</code>
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // 7. Links: [text](url) -> <a href="url">text</a>
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    return html;
}

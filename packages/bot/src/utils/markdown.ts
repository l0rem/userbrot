export function telegramMarkdownToHtml(text: string): string {
    const codeBlocks: string[] = [];
    let html = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
        const escaped = code
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        const block = lang
            ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
            : `<pre><code>${escaped}</code></pre>`;
        codeBlocks.push(block);
        return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
    });

    const inlineCodes: string[] = [];
    html = html.replace(/`([^`]+)`/g, (_match, code) => {
        const escaped = code
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        inlineCodes.push(`<code>${escaped}</code>`);
        return `\x00INLINECODE${inlineCodes.length - 1}\x00`;
    });

    html = html
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    html = html.replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>");

    html = html.replace(/(^|[^\w])_([\s\S]+?)_([^\w]|$)/g, "$1<i>$2</i>$3");
    html = html.replace(/\*(?!\*)([\s\S]+?)\*(?!\*)/g, "<i>$1</i>");

    html = html.replace(/~~([\s\S]+?)~~/g, "<s>$1</s>");

    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
        const safeUrl = url
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        if (!/^https?:\/\//i.test(safeUrl)) {
            return `[${linkText}](${safeUrl})`;
        }
        return `<a href="${safeUrl}">${linkText}</a>`;
    });

    html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx) => codeBlocks[Number(idx)]);
    html = html.replace(/\x00INLINECODE(\d+)\x00/g, (_match, idx) => inlineCodes[Number(idx)]);

    const openTags = (html.match(/<(b|i|s|code|pre|a)[\s>]/g) || []).length;
    const closeTags = (html.match(/<\/(b|i|s|code|pre|a)>/g) || []).length;
    if (openTags !== closeTags) {
        return html
            .replace(/<b>/g, "")
            .replace(/<\/b>/g, "")
            .replace(/<i>/g, "")
            .replace(/<\/i>/g, "")
            .replace(/<s>/g, "")
            .replace(/<\/s>/g, "")
            .replace(/<code>/g, "")
            .replace(/<\/code>/g, "")
            .replace(/<pre>/g, "")
            .replace(/<\/pre>/g, "")
            .replace(/<a[^>]*>/g, "")
            .replace(/<\/a>/g, "");
    }

    return html;
}
